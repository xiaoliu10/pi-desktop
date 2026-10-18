/**
 * IM notification bot: pushes task lifecycle messages to a DingTalk or
 * Feishu group via their custom-bot webhooks, or to WeChat via the
 * Serverchan/PushPlus relay (WeChat has no outbound bot API). Outbound HTTP only — the
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
  if (config.provider === 'wechat') {
    // Server酱³: POST {key}.send {title, desp}；PushPlus: POST /send {token, title, content, template}。
    // title 取首行并截断（Server酱限 32 字），全文进正文，markdown 直出。
    const title = text.split('\n')[0].slice(0, 30);
    if ((config.pushProvider ?? 'serverchan') === 'pushplus') {
      return { url: 'https://www.pushplus.plus/send', body: { token: config.botToken ?? '', title, content: text, template: 'markdown' } };
    }
    return { url: `https://sctapi.ftqq.com/${encodeURIComponent(config.botToken ?? '')}.send`, body: { title, desp: text } };
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
    /** 测试注入点：替换真实 transport 工厂，避免测试连真实 IM 网关。 */
    private readonly makeTransport?: (cfg: ImConfig) => ImTransport | null,
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
      provider: patch.provider && ['off', 'dingtalk', 'feishu', 'telegram', 'wechat'].includes(patch.provider) ? patch.provider : this.config.provider,
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
    await this.stopTransport();
    // actions2 是 lazy 工厂：启动期 host/settings 未就绪时它会抛。此前先把
    // transportKey 钉死再取 actions，异常被 index.ts 的 .catch(() => undefined)
    // 静默吞掉 → 之后 save() 因 key 相同直接 return，通道永久不启动且无日志
    // （2026-10-18 实测：配置正确但 [im-bot] 零条输出）。现在：取 actions 失败
    // 不记 key（允许下次重试），并打日志暴露原因。
    let actions: BotActions | undefined;
    try { actions = this.actions2; }
    catch (e) { console.error('[im-bot] 双向通道启动失败（actions 未就绪，稍后重试）：', (e as Error)?.message ?? e); return; }
    if (!actions || !cfg.twoWay || cfg.provider === 'off') { this.transportKey = key; return; }
    let transport: ImTransport | null = this.makeTransport
      ? this.makeTransport(cfg)
      : (() => {
          if (cfg.provider === 'dingtalk' && cfg.appKey && cfg.appSecret) {
            return new DingTalkStreamTransport({ appKey: cfg.appKey, appSecret: cfg.appSecret });
          }
          if (cfg.provider === 'feishu' && cfg.appKey && cfg.appSecret) {
            return new FeishuLongConnTransport({ appId: cfg.appKey, appSecret: cfg.appSecret });
          }
          if (cfg.provider === 'telegram' && cfg.botToken) {
            return new TelegramPollingTransport(cfg.botToken);
          }
          return null;
        })();
    if (!transport) { this.transportKey = key; return; } // 凭据不满足是稳态：记 key 避免反复重试
    this.transport = transport;
    this.transportKey = key; // 只有真正启动才记 key：中途异常不钉死，允许重试
    console.error(`[im-bot] 启动 ${cfg.provider} 双向通道`);
    const bindings = (this.config.bindings ??= {});
    await transport.start({
      onMessage: async (msg) => {
        try {
          return await handleMessage(msg.text, msg.chatId, bindings, actions!);
        } catch (e) {
          return `出错了：${String((e as Error).message || e)}`;
        }
      },
      onStatus: (msg) => console.error(`[im-bot] ${msg}`),
    });
  }

  async stopTransport(): Promise<void> {
    const transport = this.transport;
    this.transport = null;
    if (transport) await transport.stop().catch(() => undefined);
  }

  async send(text: string): Promise<void> {
    if (this.config.provider === 'wechat') {
      if (!this.config.botToken) throw new Error('请先填写推送 Token（Server酱 SendKey 或 PushPlus token）');
    } else if (this.config.provider === 'off' || !/^https:\/\//.test(this.config.webhook)) {
      throw new Error('请先选择平台并填写 https 开头的 webhook 地址');
    }
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
    if (this.config.provider === 'off') return; // notifications are best-effort
    if (this.config.provider === 'wechat' ? !this.config.botToken : !/^https:\/\//.test(this.config.webhook)) return;
    try {
      const { url, body } = buildPayload(this.config, text);
      await this.post(url, body);
    } catch {
      // a failed webhook must never break the pi event pipeline
    }
  }
}

export async function defaultPost(url: string, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`webhook 返回 ${res.status}`);
  const data = await res.json().catch(() => null) as null | { code?: number; errcode?: number; message?: string; errmsg?: string; msg?: string };
  if (!data) return; // 空体/非 JSON：HTTP ok 即视为成功
  const code = data.errcode ?? data.code;
  if (code !== undefined && code !== 0 && code !== 200) {
    throw new Error(data.errmsg || data.message || data.msg || `推送失败（code ${code}）`);
  }
}

function readJson(file: string): Partial<ImConfig> {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ImConfig>;
  } catch {
    return {};
  }
}
