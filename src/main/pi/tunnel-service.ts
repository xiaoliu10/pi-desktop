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
      });
      this.client.on('state', (s: TunnelState) => {
        this.deps.log?.(`[tunnel] state → ${s}`);
        if (s === 'error') this.lastError = '连接失败，正在重试';
      });
      this.client.on('relay-error', (code: string) => { this.lastError = `relay 错误：${code}`; });
      await this.client.start().catch(e => {
        this.lastError = String((e as Error).message ?? e);
        this.deps.log?.(`[tunnel] start failed: ${this.lastError}`);
      });
    } else {
      this.client?.stop();
      this.client = null;
    }
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
