/**
 * DingTalk Stream-mode transport: an outbound WebSocket long connection that
 * receives bot messages without any public endpoint. Protocol (open-dingtalk
 * stream SDK): open a connection ticket from the gateway, connect to the
 * returned WSS endpoint, reply ack per message, keep-alive with ping frames.
 */

import crypto from 'node:crypto';
import WebSocket from 'ws';
import type { ImTransport, IncomingMessage, TransportContext } from './transport';

const TOPIC_BOT_MESSAGE = '/v1.0/im/bot/messages/get';

export interface DingTalkCredentials {
  appKey: string;
  appSecret: string;
}

/** POST to the gateway for a stream endpoint ticket. Injectable for tests. */
export async function openConnection(
  gatewayUrl: string,
  creds: DingTalkCredentials,
  postJson: (url: string, body: unknown) => Promise<any>,
): Promise<{ endpoint: string; ticket: string }> {
  const body = {
    clientId: creds.appKey,
    clientSecret: creds.appSecret,
    subscriptions: [{ type: 'CALLBACK', topic: TOPIC_BOT_MESSAGE }],
    ua: 'pi-desktop',
    localIp: '1.1.1.1',
    localPort: 80,
  };
  const res = await postJson(gatewayUrl, body);
  if (!res?.endpoint) throw new Error(`钉钉网关返回异常：${JSON.stringify(res).slice(0, 200)}`);
  return { endpoint: res.endpoint, ticket: res.ticket ?? '' };
}

/** Decode an incoming stream frame into a bot message, or null for control frames. */
export function decodeFrame(raw: string): { messageId: string; text: string; chatId: string; sessionWebhook: string } | null {
  let frame: any;
  try {
    frame = JSON.parse(raw);
  } catch {
    return null;
  }
  const topic = frame?.headers?.topic;
  const messageId = String(frame?.headers?.messageId ?? '');
  if (topic !== TOPIC_BOT_MESSAGE || !messageId) return null;
  let payload: any;
  try {
    payload = JSON.parse(Buffer.from(String(frame.data ?? ''), 'base64').toString('utf8'));
  } catch {
    return null;
  }
  const text = String(payload?.text?.content ?? payload?.content ?? '').trim();
  const chatId = String(payload?.conversationId ?? payload?.senderStaffId ?? payload?.senderNick ?? 'unknown');
  const sessionWebhook = String(payload?.sessionWebhook ?? '');
  if (!text && !sessionWebhook) return null;
  return { messageId, text, chatId, sessionWebhook };
}

/** The per-message ack the stream gateway expects. */
export function ackFrame(messageId: string, ok: boolean): string {
  return JSON.stringify({ code: ok ? 200 : 500, headers: {}, body: '{}', message: ok ? 'OK' : 'rejected' });
}

export class DingTalkStreamTransport implements ImTransport {
  readonly id = 'dingtalk-stream';
  private ws: WebSocket | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private closedByUs = false;

  constructor(
    private readonly creds: DingTalkCredentials,
    private readonly gatewayUrl: string = 'https://api.dingtalk.com/v1.0/gateway/connections/open',
    private readonly postJson: (url: string, body: unknown) => Promise<any> = defaultPostJson,
  ) {}

  async start(ctx: TransportContext): Promise<void> {
    this.closedByUs = false;
    const { endpoint, ticket } = await openConnection(this.gatewayUrl, this.creds, this.postJson);
    const url = new URL(endpoint);
    if (ticket) url.searchParams.set('ticket', ticket);
    const ws = new WebSocket(url, { handshakeTimeout: 15000 });
    this.ws = ws;
    // Attach 'message' before awaiting 'open': a frame riding in the same TCP
    // segment as the handshake response is processed synchronously after 'open'
    // fires, and would be dropped if the listener were attached a microtask late.
    ws.on('message', (raw) => {
      const text = String(raw);
      if (text.includes('"ping"')) {
        ws.send(JSON.stringify({ code: 200, headers: {}, body: '{}', message: 'pong' }));
        return;
      }
      const msg = decodeFrame(text);
      if (!msg) return;
      void ctx
        .onMessage({ chatId: msg.chatId, text: msg.text } satisfies IncomingMessage)
        .then((reply) => {
          if (msg.sessionWebhook) {
            void this.postJson(msg.sessionWebhook, { msgtype: 'text', content: { text: reply } });
          }
          ws.send(ackFrame(msg.messageId, true));
        })
        .catch(() => ws.send(ackFrame(msg.messageId, false)));
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    ws.on('error', (err) => ctx.onStatus?.(`钉钉连接错误：${err.message}`));
    ws.on('close', () => {
      if (this.closedByUs) return;
      ctx.onStatus?.('钉钉连接断开，5 秒后重连');
      this.pingTimer && setTimeout(() => void this.start(ctx).catch(() => undefined), 5000);
    });
    // Keep-alive ping per the stream protocol.
    this.pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ code: 'ping', headers: {}, body: 'ping' }));
    }, 60_000);
  }

  async stop(): Promise<void> {
    this.closedByUs = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState !== WebSocket.CLOSED) await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { ws.terminate(); resolve(); }, 1500);
      ws.once('close', () => { clearTimeout(timer); resolve(); });
      ws.close();
    });
  }
}

async function defaultPostJson(url: string, body: unknown): Promise<any> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`钉钉网关 ${res.status}`);
  return res.json();
}

/** Constant-time-ish secret fingerprint for display in the UI. */
export function secretFingerprint(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex').slice(0, 8);
}
