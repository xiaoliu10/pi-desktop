/**
 * IM notification bot: pushes task lifecycle messages to a DingTalk or
 * Feishu group via their custom-bot webhooks. Outbound HTTP only — the
 * desktop never needs a public endpoint. Two-way chat control (reply from
 * IM to drive pi) requires DingTalk Stream / Feishu long-connection apps
 * and is intentionally not part of this module yet.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { PiEvent } from '../../shared/pi';
import { handleMessage, type BotActions } from './bot/engine';
import type { ImTransport } from './bot/transport';
import { DingTalkStreamTransport } from './bot/dingtalk-stream';
import { FeishuLongConnTransport } from './bot/feishu-longconn';
import { TelegramPollingTransport } from './bot/telegram-polling';

import type { ImConfig } from '../../shared/pi';
export type { ImConfig } from '../../shared/pi';
export type ImProvider = ImConfig['provider'];

export const DEFAULT_IM_CONFIG: ImConfig = {
  provider: 'off',
  webhook: '',
  secret: '',
  notifyCompleted: true,
  notifyError: true,
  notifyAttention: true,
};

/** DingTalk custom-bot signature: base64(HmacSHA256(secret, `${ts}\n${secret}`)). */
export function dingtalkSign(secret: string, timestamp: number): string {
  return crypto.createHmac('sha256', secret).update(`${timestamp}\n${secret}`).digest('base64');
}

/** Feishu custom-bot signature: base64(HmacSHA256(key=`${ts}\n${secret}`, message='')). */
export function feishuSign(secret: string, timestamp: number): string {
  return crypto.createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64');
}

export function buildPayload(config: ImConfig, text: string): { url: string; body: Record<string, unknown> } {
  if (config.provider === 'dingtalk') {
    let url = config.webhook;
    if (config.secret) {
      const ts = Date.now();
      url += `&timestamp=${ts}&sign=${encodeURIComponent(dingtalkSign(config.secret, ts))}`;
    }
    return { url, body: { msgtype: 'text', text: { content: text } } };
  }
  if (config.provider === 'feishu') {
    const body: Record<string, unknown> = { msg_type: 'text', content: { text } };
    if (config.secret) {
      const ts = Math.floor(Date.now() / 1000);
      body.timestamp = String(ts);
      body.sign = feishuSign(config.secret, ts);
    }
    return { url: config.webhook, body };
  }
  return { url: '', body: {} };
}

/** Tracks run transitions and pushes notifications for the enabled kinds. */
export class ImBot {
  private config: ImConfig = DEFAULT_IM_CONFIG;
  private lastStatus = new Map<string, string>();
  private lastNotifiedGeneration = new Set<string>();
  private transport: ImTransport | null = null;
  private transportKey = '';

  constructor(
    private readonly configPath: string,
    private readonly post: (url: string, body: Record<string, unknown>) => Promise<void> = defaultPost,
    private readonly actions?: BotActions | (() => BotActions),
  ) {
    this.config = { ...DEFAULT_IM_CONFIG, ...readJson(configPath) };
  }

  private get actions2(): BotActions | undefined {
    if (!this.actions) return undefined;
    return typeof this.actions === 'function' ? this.actions() : this.actions;
  }

  get current(): ImConfig {
    return this.config;
  }

  save(patch: Partial<ImConfig>): ImConfig {
    this.config = {
      ...this.config,
      ...patch,
      provider: patch.provider && ['off', 'dingtalk', 'feishu', 'telegram'].includes(patch.provider) ? patch.provider : this.config.provider,
    };
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
    void this.syncTransport();
    return this.config;
  }

  /** Start/stop the two-way transport so it always matches the saved config. */
  async syncTransport(): Promise<void> {
    const cfg = this.config;
    const key = `${cfg.provider}|${cfg.twoWay ? 1 : 0}|${cfg.appKey ?? ''}|${cfg.appSecret ?? ''}|${cfg.botToken ?? ''}`;
    if (key === this.transportKey) return;
    this.transportKey = key;
    await this.stopTransport();
    const actions = this.actions2;
    if (!actions || !cfg.twoWay || cfg.provider === 'off') return;
    let transport: ImTransport | null = null;
    if (cfg.provider === 'dingtalk' && cfg.appKey && cfg.appSecret) {
      transport = new DingTalkStreamTransport({ appKey: cfg.appKey, appSecret: cfg.appSecret });
    } else if (cfg.provider === 'feishu' && cfg.appKey && cfg.appSecret) {
      transport = new FeishuLongConnTransport({ appId: cfg.appKey, appSecret: cfg.appSecret });
    } else if (cfg.provider === 'telegram' && cfg.botToken) {
      transport = new TelegramPollingTransport(cfg.botToken);
    }
    if (!transport) return;
    this.transport = transport;
    const bindings = (this.config.bindings ??= {});
    await transport.start({
      onMessage: async (msg) => {
        try {
          return await handleMessage(msg.text, msg.chatId, bindings, actions!);
        } catch (e) {
          return `出错了：${String((e as Error).message || e)}`;
        }
      },
      onStatus: () => undefined,
    });
  }

  async stopTransport(): Promise<void> {
    const transport = this.transport;
    this.transport = null;
    if (transport) await transport.stop().catch(() => undefined);
  }

  async send(text: string): Promise<void> {
    if (this.config.provider === 'off' || !/^https:\/\//.test(this.config.webhook)) throw new Error('请先选择平台并填写 https 开头的 webhook 地址');
    const { url, body } = buildPayload(this.config, text);
    await this.post(url, body);
  }

  /** Called for every pi event; fires at most one message per generation per kind. */
  async onPiEvent(event: PiEvent, describe: (key: string) => string): Promise<void> {
    if (event.type === 'run') {
      const run = event.run;
      const prev = this.lastStatus.get(run.key);
      this.lastStatus.set(run.key, run.status);
      if (!prev) return; // first sight of this run — no transition yet
      const name = describe(run.key);
      if (prev === 'running' && run.status === 'idle' && this.config.notifyCompleted) {
        await this.fireOnce(`gen:${run.generation}:done`, `✅ ${name} 任务完成`);
      } else if (run.status === 'error' && this.config.notifyError) {
        await this.fireOnce(`gen:${run.generation}:err`, `❌ ${name} 任务出错${run.error ? `：${run.error}` : ''}`);
      }
    } else if (event.type === 'ui' && this.config.notifyAttention) {
      if (['select', 'confirm', 'input', 'editor'].includes(event.request.method)) {
        await this.fireOnce(`ui:${event.request.id}`, `⏸️ ${describe(event.key)} 等待你的确认：${event.request.title || event.request.method}`);
      }
    }
  }

  private async fireOnce(key: string, text: string): Promise<void> {
    if (this.lastNotifiedGeneration.has(key)) return;
    this.lastNotifiedGeneration.add(key);
    if (this.lastNotifiedGeneration.size > 500) this.lastNotifiedGeneration.clear();
    if (this.config.provider === 'off' || !/^https:\/\//.test(this.config.webhook)) return; // notifications are best-effort
    try {
      const { url, body } = buildPayload(this.config, text);
      await this.post(url, body);
    } catch {
      // a failed webhook must never break the pi event pipeline
    }
  }
}

async function defaultPost(url: string, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`webhook 返回 ${res.status}`);
}

function readJson(file: string): Partial<ImConfig> {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ImConfig>;
  } catch {
    return {};
  }
}
