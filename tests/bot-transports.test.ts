import { describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import http from 'node:http';
import { ackFrame, decodeFrame, DingTalkStreamTransport, openConnection } from '../src/main/pi/bot/dingtalk-stream';
import { extractUpdateText, TelegramPollingTransport } from '../src/main/pi/bot/telegram-polling';
import { extractFeishuEvent } from '../src/main/pi/bot/feishu-longconn';

describe('DingTalk stream protocol', () => {
  it('opens a connection ticket via the gateway', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const res = await openConnection('https://gw.example/open', { appKey: 'k', appSecret: 's' }, async (url, body) => {
      calls.push({ url, body });
      return { endpoint: 'wss://stream.example/connect', ticket: 'T1' };
    });
    expect(res.endpoint).toBe('wss://stream.example/connect');
    expect(res.ticket).toBe('T1');
    expect(calls[0].url).toBe('https://gw.example/open');
    expect((calls[0].body as { clientId: string }).clientId).toBe('k');
    expect((calls[0].body as { subscriptions: Array<{ topic: string }> }).subscriptions[0].topic).toBe('/v1.0/im/bot/messages/get');
  });

  it('throws on a gateway error response', async () => {
    await expect(openConnection('gw', { appKey: 'k', appSecret: 's' }, async () => ({ code: 'Forbidden' }))).rejects.toThrow('钉钉网关');
  });

  it('decodes bot message frames and ignores control frames', () => {
    const payload = Buffer.from(JSON.stringify({ text: { content: '/状态' }, conversationId: 'cid-1', sessionWebhook: 'https://oapi.dingtalk.com/robot/send?sessionWebhook=abc' })).toString('base64');
    const frame = JSON.stringify({ headers: { topic: '/v1.0/im/bot/messages/get', messageId: 'm-1' }, data: payload });
    const msg = decodeFrame(frame);
    expect(msg).toEqual({ messageId: 'm-1', text: '/状态', chatId: 'cid-1', sessionWebhook: 'https://oapi.dingtalk.com/robot/send?sessionWebhook=abc' });
    expect(decodeFrame(JSON.stringify({ headers: { topic: '/v1.0/im/bot/other', messageId: 'x' }, data: '' }))).toBeNull();
    expect(decodeFrame('not json')).toBeNull();
  });

  it('acks with 200/500 per the stream protocol', () => {
    expect(JSON.parse(ackFrame('m', true)).code).toBe(200);
    expect(JSON.parse(ackFrame('m', false)).code).toBe(500);
  });

  it('end-to-end: fake gateway + ws server, message in → reply out', async () => {
    const received: string[] = [];
    const server = http.createServer((req, res) => {
      if (req.url?.includes('/gateway')) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ endpoint: `ws://127.0.0.1:${wsPort}/ws`, ticket: 'T' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    const wss = new WebSocketServer({ noServer: true });
    const wsPort = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });
    server.on('upgrade', (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.on('message', (raw) => {
          const text = String(raw);
          if (text.includes('ping')) {
            ws.send(JSON.stringify({ code: 'ping' }));
            return;
          }
          received.push(text);
        });
        const payload = Buffer.from(JSON.stringify({ text: { content: '/状态' }, conversationId: 'chat-9', sessionWebhook: `http://127.0.0.1:${wsPort}/reply` })).toString('base64');
        ws.send(JSON.stringify({ headers: { topic: '/v1.0/im/bot/messages/get', messageId: 'm-2' }, data: payload }));
      });
    });

    const replies: string[] = [];
    const transport = new DingTalkStreamTransport(
      { appKey: 'k', appSecret: 's' },
      `http://127.0.0.1:${wsPort}/gateway`,
      async (url, body) => {
        if (url.includes('/reply')) {
          replies.push(String((body as { content?: { text?: string } })?.content?.text ?? ''));
          return {};
        }
        // gateway call
        const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        return res.json();
      },
    );
    await transport.start({ onMessage: async () => '状态回复文本' });
    await new Promise((r) => setTimeout(r, 300));
    expect(received.some((t) => t.includes('"code":200'))).toBe(true); // ack sent
    expect(replies).toEqual(['状态回复文本']);
    await transport.stop();
    server.close();
    wss.close();
  });
});

describe('Telegram polling', () => {
  it('extracts text updates', () => {
    expect(extractUpdateText({ message: { text: '/状态', chat: { id: 42 } }, update_id: 1 })).toEqual({ chatId: '42', text: '/状态' });
    expect(extractUpdateText({ message: { chat: { id: 1 } } })).toBeNull();
  });

  it('validates the bot token against getMe', async () => {
    const transport = new TelegramPollingTransport('BAD', 'https://tg.example', async (url) => {
      if (url.includes('getMe')) return { ok: false };
      return { ok: true, result: [] };
    });
    await expect(transport.start({ onMessage: async () => '' })).rejects.toThrow('Token');
    await transport.stop();
  });

  it('replies via sendMessage and advances the offset', async () => {
    const calls: string[] = [];
    let polls = 0;
    const transport = new TelegramPollingTransport('TOK', 'https://tg.example', async (url, init) => {
      calls.push(url);
      if (url.includes('getMe')) return { ok: true, result: { username: 'pi_bot' } };
      if (url.includes('getUpdates')) {
        polls += 1;
        if (polls === 1) {
          return { ok: true, result: [{ update_id: 7, message: { text: '/帮助', chat: { id: 5 } } }] };
        }
        // Real long-polling blocks server-side; emulate that so the loop doesn't spin.
        await new Promise((r) => setTimeout(r, 20));
        return { ok: true, result: [] };
      }
      if (url.includes('sendMessage')) return { ok: true };
      throw new Error(url);
    });
    const run = transport.start({ onMessage: async (msg) => `echo:${msg.text}` });
    await new Promise((r) => setTimeout(r, 200));
    await transport.stop();
    await run;
    expect(calls.some((c) => c.includes('offset=8'))).toBe(true);
    const sent = calls.find((c) => c.includes('sendMessage'));
    expect(sent).toBeTruthy();
  });
});

describe('Feishu long-conn events', () => {
  it('extracts text from im.message.receive_v1 envelopes and strips mentions', () => {
    const envelope = {
      header: { event_type: 'im.message.receive_v1' },
      event: { message: { chat_id: 'oc1', message_id: 'om1', content: JSON.stringify({ text: '@Bot /状态' }) } },
    };
    expect(extractFeishuEvent(envelope)).toEqual({ chatId: 'oc1', messageId: 'om1', text: '/状态' });
    expect(extractFeishuEvent({ header: { event_type: 'other' } })).toBeNull();
  });
});
