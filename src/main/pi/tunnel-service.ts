import fs from 'node:fs';
import path from 'node:path';
import { TunnelClient, type TunnelState } from './tunnel-client';
import { encryptSecret, decryptSecret } from '../secrets';

/**
 * 远程隧道服务（方案 D §4.3）：配置持久化 + TunnelClient 生命周期。
 *
 * relay 地址与 device 明文存 JSON；relay key 经 Electron safeStorage 加密
 * （与 API key 同级敏感，落盘必须是密文）。app 启动时不自动连——用户在
 * 设置里开启后才连，与 LAN remote-server 的 start 语义一致。
 */
export interface TunnelConfig {
  enabled: boolean;
  relayUrl: string;
  /** 密文（encryptSecret 输出）；永不明文落盘 */
  keyEncrypted?: string;
  deviceName: string;
}

export interface TunnelStatus {
  enabled: boolean;
  state: TunnelState;
  deviceSid?: string;
  relayUrl?: string;
  error?: string;
}

const DEFAULTS: TunnelConfig = { enabled: false, relayUrl: '', deviceName: '' };

export class TunnelService {
  private config: TunnelConfig = { ...DEFAULTS };
  private client: TunnelClient | null = null;
  private lastError = '';

  constructor(
    private readonly configPath: string,
    private readonly deps: {
      localBase: () => string;
      localToken: () => string;
      /** 启动恢复用：确保 LAN remote-server 在跑（tunnel 转发的目标）。 */
      ensureLocal?: () => unknown;
      /** relay HTTP 注入口（测试用）；不设则用全局 fetch */
      relayFetch?: typeof fetch;
      /** WS 工厂注入口（测试用）；不设则用真实 WebSocket */
      wsFactory?: (url: string) => never;
      log?: (msg: string) => void;
    },
  ) {
    this.config = this.load();
  }

  get current(): TunnelConfig {
    return { ...this.config, keyEncrypted: this.config.keyEncrypted ? '********' : undefined };
  }

  private load(): TunnelConfig {
    try {
      const raw = JSON.parse(fs.readFileSync(this.configPath, 'utf8')) as Partial<TunnelConfig>;
      return {
        enabled: raw.enabled === true,
        relayUrl: typeof raw.relayUrl === 'string' ? raw.relayUrl : '',
        keyEncrypted: typeof raw.keyEncrypted === 'string' ? raw.keyEncrypted : undefined,
        deviceName: typeof raw.deviceName === 'string' ? raw.deviceName : '',
      };
    } catch {
      return { ...DEFAULTS };
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
  }

  /** 保存配置；key 传明文（空 = 不改），落盘前加密。变更后按 enabled 重连。 */
  async save(patch: Partial<Pick<TunnelConfig, 'enabled' | 'relayUrl' | 'deviceName'>> & { key?: string }): Promise<TunnelConfig> {
    const next: TunnelConfig = { ...this.config };
    if (patch.relayUrl !== undefined) next.relayUrl = patch.relayUrl.trim();
    if (patch.deviceName !== undefined) next.deviceName = patch.deviceName.trim();
    if (patch.key !== undefined && patch.key !== '') next.keyEncrypted = encryptSecret(patch.key);
    if (patch.enabled !== undefined) next.enabled = patch.enabled;
    // 构造 TunnelClient 做地址校验（内嵌凭据等），校验失败直接抛给设置页
    if (next.relayUrl) {
      new TunnelClient({
        relayUrl: next.relayUrl, key: 'validate-only', deviceMid: 'validate',
        localBase: () => this.deps.localBase(), localToken: () => this.deps.localToken(),
      }).stop();
    }
    this.config = next;
    this.persist();
    await this.sync();
    return this.current;
  }

  /**
   * app 启动恢复：配置里 enabled=true → 自动拉起 LAN 并重连 relay。
   * 此前 sync() 只在点按钮（save）时被调用，重启后配置永远躺在文件里，
   * 状态停在 stopped 而按钮却是「关闭隧道」——用户实测（2026-10-30）。
   * LAN 拉起失败不阻断 relay 连接（localBase 惰性，只影响转发时刻）。
   */
  async startup(): Promise<void> {
    if (!this.config.enabled) return;
    try { await this.deps.ensureLocal?.(); }
    catch (e) { this.lastError = `LAN 启动失败：${String((e as Error).message ?? e)}`; this.deps.log?.(`[tunnel] ${this.lastError}`); }
    await this.sync();
  }

  /** 让运行中的 client 与配置一致（enable→start，disable→stop）。 */
  private async sync(): Promise<void> {
    if (this.config.enabled && this.config.relayUrl && this.config.keyEncrypted) {
      if (this.client) return; // 已在跑；配置变更走 stop 路径重建
      this.lastError = '';
      const key = decryptSecret(this.config.keyEncrypted) ?? '';
      this.client = new TunnelClient({
        relayUrl: this.config.relayUrl,
        key,
        deviceMid: this.config.deviceName || 'pi-desktop',
        localBase: () => this.deps.localBase(),
        localToken: () => this.deps.localToken(),
        // 注入口必须透传：否则测试 stub 失效，client 会用全局 fetch 连真实网络
        //（表现为 stub 0 次调用 + 状态停在 connecting）。
        ...(this.deps.relayFetch ? { relayFetch: this.deps.relayFetch } : {}),
        ...(this.deps.wsFactory ? { wsFactory: this.deps.wsFactory } : {}),
      });
      this.client.on('state', (s: TunnelState) => {
        this.deps.log?.(`[tunnel] state → ${s}`);
        if (s === 'error') this.lastError = '连接失败，正在重试';
      });
      this.client.on('relay-error', (code: string) => { this.lastError = `relay 错误：${code}`; });
      // client 每次 attempt 失败（注册 401「relay key 被拒绝」、网络失败等）都会 emit
      // 'error'；不接线的话 lastError 永远为空，UI 永远停在「连接 relay 中」——
      // 2026-11-11 用户实报：key 失效后无任何失败原因可见。
      this.client.on('error', (e: unknown) => {
        this.lastError = String((e as Error).message ?? e);
        this.deps.log?.(`[tunnel] ${this.lastError}`);
      });
      await this.client.start().catch(e => {
        this.lastError = String((e as Error).message ?? e);
        this.deps.log?.(`[tunnel] start failed: ${this.lastError}`);
      });
    } else {
      this.client?.stop();
      this.client = null;
    }
  }

  /**
   * 生成手机端一次性配对二维码（relay 托管页，方案 D §4.4）。
   * 调 relay 的 /api/v1/remote/pair 换 60s 一次性 token + view_url；
   * 手机扫码打开该 URL，页面 JS 随即以 terminal 角色连同一 relay。
   * 隧道未启用/未连接时返回 null（UI 隐藏二维码区）。
   */
  /** pair 结果 50s 缓存：token 60s 有效，设置页 3s 轮询每次调用也不能频繁换码。 */
  private pairCache: { at: number; data: { viewUrl: string; token: string; expiresIn: number } } | null = null;

  async pair(): Promise<{ viewUrl: string; token: string; expiresIn: number } | null> {
    // waiting/paired 都算「relay 已连上」：手机本身就是终端，从扫这个码开始，
    // 要求先 paired 才给码是鸡生蛋（用户实测：状态「等待终端」时扫不到公网码）。
    const st = this.client?.state();
    if (!this.client || (st !== 'paired' && st !== 'waiting')) { this.pairCache = null; return null; }
    if (this.pairCache && Date.now() - this.pairCache.at < 50_000) return this.pairCache.data;
    const key = decryptSecret(this.config.keyEncrypted) ?? '';
    const base = new URL(this.config.relayUrl);
    const prefix = base.pathname.replace(/\/$/, '');
    const url = base.origin + prefix + '/api/v1/remote/pair';
    const doFetch = this.deps.relayFetch ?? fetch;
    const res = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-relay-key': key },
      body: JSON.stringify({ device_sid: this.client.deviceSid() }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`relay /api/v1/remote/pair → HTTP ${res.status}`);
    const json = await res.json() as { code: number; data?: { token: string; expires_in: number; view_url: string } };
    if (json.code !== 0 || !json.data) throw new Error('relay 配对失败');
    // relay 在 nginx 反代后面：它看到的 Host 不含路径前缀、协议是明文 http。
    // view_url 必须用「配置的 relayUrl」的协议+路径前缀重写，否则二维码扫出来 404。
    const view = new URL(json.data.view_url);
    view.protocol = base.protocol;
    view.pathname = prefix + view.pathname;
    const result = { viewUrl: view.toString(), token: json.data.token, expiresIn: json.data.expires_in };
    this.pairCache = { at: Date.now(), data: result };
    return result;
  }

  async status(): Promise<TunnelStatus> {
    return {
      enabled: this.config.enabled,
      state: this.client?.state() ?? 'stopped',
      deviceSid: this.client?.deviceSid() || undefined,
      relayUrl: this.config.relayUrl || undefined,
      error: this.lastError || undefined,
    };
  }

  async stop(): Promise<void> {
    this.client?.stop();
    this.client = null;
  }
}
