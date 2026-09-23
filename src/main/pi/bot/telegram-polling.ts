/**
 * Telegram long-polling transport: the simplest two-way channel — only needs
 * a BotFather bot token. Outbound HTTPS polling only, no public endpoint.
 * Note: reaching api.telegram.org requires network access to Telegram.
 */

import type { ImTransport, IncomingMessage, TransportContext } from './transport';

const API = 'https://api.telegram.org';

export function extractUpdateText(update: any): { chatId: string; text: string } | null {
  const msg = update?.message ?? update?.edited_message;
  const text = String(msg?.text ?? '').trim();
  const chatId = String(msg?.chat?.id ?? '');
  if (!text || !chatId) return null;
  return { chatId, text };
}

export class TelegramPollingTransport implements ImTransport {
  readonly id = 'telegram';
  private stopped = false;

  constructor(
    private readonly token: string,
    private readonly baseUrl: string = API,
    private readonly fetchJson: (url: string, init?: RequestInit) => Promise<any> = defaultFetchJson,
  ) {}

  async start(ctx: TransportContext): Promise<void> {
    this.stopped = false;
    const me = await this.fetchJson(`${this.baseUrl}/bot${this.token}/getMe`);
    if (!me?.ok) throw new Error('Telegram Bot Token 无效');
    ctx.onStatus?.(`Telegram bot @${me.result.username} 已连接`);
    let offset = 0;
    while (!this.stopped) {
      try {
        const res = await this.fetchJson(`${this.baseUrl}/bot${this.token}/getUpdates?timeout=50&offset=${offset}`);
        for (const update of res?.result ?? []) {
          offset = Math.max(offset, Number(update.update_id ?? 0) + 1);
          const msg = extractUpdateText(update);
          if (!msg) continue;
          const reply = await ctx.onMessage({ chatId: msg.chatId, text: msg.text } satisfies IncomingMessage);
          await this.fetchJson(`${this.baseUrl}/bot${this.token}/sendMessage`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ chat_id: msg.chatId, text: reply }),
          });
        }
      } catch (err) {
        if (this.stopped) return;
        ctx.onStatus?.(`Telegram 轮询错误：${String((err as Error).message || err)}`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }
}

async function defaultFetchJson(url: string, init?: RequestInit): Promise<any> {
  const res = await fetch(url, init);
  return res.json();
}
