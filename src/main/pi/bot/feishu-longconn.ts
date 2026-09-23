import WebSocket from 'ws';
/**
 * Feishu/Lark long-connection transport (experimental): outbound WebSocket to
 * the open-platform callback gateway. Protocol per Lark SDK v2: exchange
 * app credentials for a WS endpoint ticket, connect, ack events with code
 * 200, reply through the im/v1/messages API using the chat id.
 *
 * Marked experimental: only tested against the documented protocol shape.
 */

import type { ImTransport, IncomingMessage, TransportContext } from './transport';

const EVENT_MESSAGE = 'im.message.receive_v1';

export interface FeishuCredentials {
  appId: string;
  appSecret: string;
  /** 'feishu' | 'lark' — the two deployments have separate gateways. */
  region?: 'feishu' | 'lark';
}

export function extractFeishuEvent(envelope: any): { chatId: string; messageId: string; text: string } | null {
  const header = envelope?.header;
  if (header?.event_type !== EVENT_MESSAGE) return null;
  const msg = envelope?.event?.message;
  const chatId = String(msg?.chat_id ?? '');
  const messageId = String(msg?.message_id ?? '');
  let text = String(msg?.content ?? '');
  try {
    const parsed = JSON.parse(text) as { text?: string };
    if (typeof parsed.text === 'string') text = parsed.text; // im.message text payloads are JSON-wrapped
  } catch {
    /* keep raw */
  }
  text = text.replace(/^@\S+\s*/, '').trim(); // strip @bot mention
  if (!chatId || !text) return null;
  return { chatId, messageId, text };
}

export class FeishuLongConnTransport implements ImTransport {
  readonly id = 'feishu-longconn';
  private stopped = false;
  private WebSocketCtor: typeof WebSocket;

  constructor(
    private readonly creds: FeishuCredentials,
    private readonly fetchJson: (url: string, init?: RequestInit) => Promise<any> = defaultFetchJson,
    WebSocketImpl: typeof WebSocket = WebSocket,
  ) {
    this.WebSocketCtor = WebSocketImpl;
  }

  private gateway(region: 'feishu' | 'lark'): string {
    return region === 'lark' ? 'https://open.larksuite.com/callback/ws/endpoint' : 'https://open.feishu.cn/callback/ws/endpoint';
  }

  private apiBase(region: 'feishu' | 'lark'): string {
    return region === 'lark' ? 'https://open.larksuite.com/open-apis' : 'https://open.feishu.cn/open-apis';
  }

  async start(ctx: TransportContext): Promise<void> {
    this.stopped = false;
    const region = this.creds.region ?? 'feishu';
    const open = await this.fetchJson(
      `${this.gateway(region)}?app_id=${encodeURIComponent(this.creds.appId)}&app_secret=${encodeURIComponent(this.creds.appSecret)}`,
    );
    const url: string | undefined = open?.data?.URL ?? open?.data?.url;
    const ticket: string | undefined = open?.data?.Ticket ?? open?.data?.ticket;
    if (open?.code !== 0 || !url) throw new Error(`飞书长连接开通失败：${JSON.stringify(open).slice(0, 200)}`);
    const ws = new this.WebSocketCtor(ticket ? `${url}?ticket=${encodeURIComponent(ticket)}` : url);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    let token: { value: string; exp: number } | null = null;
    const tenantToken = async (): Promise<string> => {
      if (token && token.exp > Date.now() / 1000 + 60) return token.value;
      const res = await this.fetchJson(`${this.apiBase(region)}/auth/v3/tenant_access_token/internal`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ app_id: this.creds.appId, app_secret: this.creds.appSecret }),
      });
      token = { value: String(res?.tenant_access_token ?? ''), exp: Number(res?.expire ?? 0) };
      return token.value;
    };
    ws.on('message', (raw) => {
      const text = String(raw);
      if (text.includes('"type":"ping"') || text.includes('"pong"')) {
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }
      let envelope: any;
      try {
        envelope = JSON.parse(text);
      } catch {
        return;
      }
      const event = extractFeishuEvent(envelope);
      ws.send(JSON.stringify({ code: 200, headers: envelope?.headers ?? {}, body: '{}' }));
      if (!event) return;
      void ctx
        .onMessage({ chatId: event.chatId, text: event.text } satisfies IncomingMessage)
        .then(async (reply) => {
          const auth = await tenantToken();
          await this.fetchJson(`${this.apiBase(region)}/im/v1/messages?receive_id_type=chat_id`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${auth}` },
            body: JSON.stringify({ receive_id: event.chatId, msg_type: 'text', content: JSON.stringify({ text: reply }) }),
          });
        })
        .catch(() => undefined);
    });
    ws.on('close', () => {
      if (this.stopped) return;
      ctx.onStatus?.('飞书长连接断开，5 秒后重连');
      setTimeout(() => void this.start(ctx).catch(() => undefined), 5000);
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }
}

async function defaultFetchJson(url: string, init?: RequestInit): Promise<any> {
  const res = await fetch(url, init);
  return res.json();
}
