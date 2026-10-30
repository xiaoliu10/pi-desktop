import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import WebSocket from 'ws';

/**
 * 桌面侧 tunnel-client（方案 D，docs/design/remote-tunnel.md §4.3）。
 *
 * 桌面作为 device 主动外连 relay（WSS），NAT 后无需任何入站端口。relay 只按 sid
 * 双向转发，不解析 payload；terminal 发来的每一帧在这里被还原成对本地 remote-server
 * 的 HTTP 调用，再把响应/事件封成 data 帧送回去。
 *
 * 生命周期（ZCode V2 契约裁剪）：
 *   register(device_mid) → device_sid
 *   token(role=device)   → 60s 一次性 token
 *   WS upgrade（原子消费 token）→ auth_ack(waiting/matched)
 *   心跳 5s±1s jitter；15s 无任何帧视为断线，重连（含重新注册/重新拿 token）
 *   同 sid 新连接会替换旧连接（relay 侧踢旧）
 */
export interface TunnelClientOptions {
  /** relay 地址，如 https://ecs.example.com:8443（不得带凭据，见 Harness relay-url 同款校验） */
  relayUrl: string;
  /** 预共享 key */
  key: string;
  /** 本机标识（device_mid），一般用 hostname */
  deviceMid: string;
  /** 本地 remote-server 的 base，如 http://127.0.0.1:3123 */
  localBase: string;
  /** 本地 token（调 localBase 时用 Authorization: Bearer 传） */
  localToken: () => string;
  /** relay HTTP 注入口（测试用）；不设则用全局 fetch */
  relayFetch?: typeof fetch;
  /** 本地 remote-server 调用注入口（测试用）；不设则用全局 fetch */
  fetchImpl?: typeof fetch;
  wsFactory?: (url: string) => WebSocketLike;
}

export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'open' | 'close' | 'error', cb: () => void): void;
  on(event: 'message', cb: (data: WebSocket.RawData) => void): void;
  on(event: string, cb: (...args: never[]) => void): void;
}

export type TunnelState = 'stopped' | 'connecting' | 'waiting' | 'paired' | 'error';

const HEARTBEAT_MS = 5_000;
const HEARTBEAT_JITTER_MS = 1_000;
const ACK_DEADLINE_MS = 15_000;

export class TunnelClient extends EventEmitter {
  private ws: WebSocketLike | null = null;
  private sid = '';
  private tunnelState: TunnelState = 'stopped';
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private ackTimer: NodeJS.Timeout | null = null;
  private generation = 0;
  private lastServerTs = 0;

  constructor(private readonly opts: TunnelClientOptions) {
    super();
    this.validateRelayUrl(opts.relayUrl);
  }

  /** Harness relay-url 同款校验：拒绝内嵌凭据（RFC 6819：凭据不进 URL）。 */
  private validateRelayUrl(value: string): void {
    const u = new URL(value);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('relayUrl 必须是 http(s)');
    if (u.username || u.password) throw new Error('relayUrl 不得包含凭据（用 key 字段）');
  }

  state(): TunnelState { return this.tunnelState; }
  deviceSid(): string { return this.sid; }

  private setState(s: TunnelState): void {
    if (this.tunnelState !== s) { this.tunnelState = s; this.emit('state', s); }
  }

  async start(): Promise<void> {
    if (this.tunnelState !== 'stopped') return;
    this.stopped = false;
    this.generation++;
    await this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
    this.clearTimers();
    try { this.ws?.close(1000, 'client-stop'); } catch { /* already closed */ }
    this.ws = null;
    this.setState('stopped');
  }

  private clearTimers(): void {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.ackTimer) { clearTimeout(this.ackTimer); this.ackTimer = null; }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.clearTimers();
    this.setState('connecting');
    // 指数退避 + 抖动，避免重连风暴（frp/ZCode 均有同类机制）
    const attempt = Math.min(this.connectAttempts++, 6);
    const delay = Math.min(1000 * 2 ** attempt, 30_000) + Math.floor(Math.random() * 500);
    const gen = this.generation;
    this.reconnectTimer = setTimeout(async () => {
      if (this.stopped || gen !== this.generation) return;
      await this.connect();
    }, delay);
  }
  private connectAttempts = 0;

  private async connect(): Promise<void> {
    this.clearTimers();
    this.setState('connecting');
    try {
      // 1) 注册（幂等：relay 每次返回新 sid）
      const reg = await this.api<{ device_sid: string }>('/api/v1/remote/device', { device_mid: this.opts.deviceMid });
      this.sid = reg.device_sid;
      // 2) 一次性 token（60s）
      const tok = await this.api<{ token: string; expires_in: number }>('/api/v1/remote/token', { role: 'device' });
      // 3) WS upgrade（relay 原子消费 token）。ws:// 串手工拼，避免 URL 二次解析丢路径。
      const wsBase = this.opts.relayUrl.replace(/^http/, 'ws').replace(/\/$/, '');
      const wsUrl = new URL(wsBase + '/api/v1/remote/ws2');
      wsUrl.searchParams.set('role', 'device');
      wsUrl.searchParams.set('token', tok.token);
      wsUrl.searchParams.set('sid', this.sid);
      const ws = this.opts.wsFactory ? this.opts.wsFactory(wsUrl.toString()) : new WebSocket(wsUrl.toString());
      this.ws = ws;
      ws.on('open', () => {
        this.connectAttempts = 0;
        this.sendAuth();
        this.startHeartbeat();
        this.armAckDeadline();
      });
      ws.on('message', (raw) => this.onFrame(String(raw)));
      ws.on('close', () => {
        if (!this.stopped) this.scheduleReconnect();
      });
      ws.on('error', () => { /* close 事件会跟进来 */ });
    } catch (e) {
      this.emit('error', e);
      this.scheduleReconnect();
    }
  }

  private sendAuth(): void {
    this.sendFrame({ type: 'auth_init', device_sid: this.sid, meta: { name: this.opts.deviceMid }, client_ts: Math.floor(Date.now() / 1000) });
  }

  private startHeartbeat(): void {
    const tick = () => {
      if (this.stopped || !this.ws) return;
      // ±1s jitter（ZCode V2）
      const jitter = Math.floor(Math.random() * HEARTBEAT_JITTER_MS);
      this.heartbeatTimer = setTimeout(() => {
        this.sendFrame({ type: 'pair_status_query', client_ts: Math.floor(Date.now() / 1000) });
        this.armAckDeadline();
        tick();
      }, HEARTBEAT_MS + jitter);
    };
    tick();
  }

  private armAckDeadline(): void {
    if (this.ackTimer) clearTimeout(this.ackTimer);
    const gen = this.generation;
    this.ackTimer = setTimeout(() => {
      if (this.stopped || gen !== this.generation) return;
      // 15s 没有任何帧 → 视为断线重连（ZCode V2 ACK deadline）
      try { this.ws?.close(4000, 'ack-timeout'); } catch { /* noop */ }
    }, ACK_DEADLINE_MS);
  }

  private onFrame(raw: string): void {
    let frame: any;
    try { frame = JSON.parse(raw); } catch { return; }
    if (!frame || typeof frame !== 'object') return;
    // 收到任何帧都重置 ACK deadline
    if (frame.server_ts && typeof frame.server_ts === 'number') this.lastServerTs = frame.server_ts;
    this.armAckDeadline();
    switch (frame.type) {
      case 'auth_ack':
        this.setState(frame.pair_status === 'matched' ? 'paired' : 'waiting');
        break;
      case 'pair_status_ack':
        this.setState(frame.pair_status === 'matched' ? 'paired' : 'waiting');
        break;
      case 'data':
        void this.handleData(frame.payload);
        break;
      case 'error':
        if (frame.code === 'KICKED') {
          // 同 sid 别处登录：本连接失效，立即重连（会拿到新 sid）
          try { this.ws?.close(); } catch { /* noop */ }
        }
        this.emit('relay-error', frame.code);
        break;
      default:
        // Harness 原则：不认识的帧明确拒绝，不静默
        this.sendFrame({ type: 'error', code: 'WRONG_PARAM' });
    }
  }

  /** terminal 发来的 HTTP 请求帧 → 本地 remote-server → 回包 */
  private async handleData(payload: unknown): Promise<void> {
    const req = payload as { id?: string; method?: string; path?: string; body?: unknown; headers?: Record<string, string> };
    if (!req || typeof req !== 'object' || typeof req.id !== 'string' || typeof req.method !== 'string' || typeof req.path !== 'string') {
      this.sendFrame({ type: 'error', code: 'WRONG_PARAM' });
      return;
    }
    const url = new URL(req.path, this.opts.localBase);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      authorization: `Bearer ${this.opts.localToken()}`,
      ...(req.headers ?? {}),
    };
    let status = 502;
    let body: unknown = { error: 'upstream unavailable' };
    try {
      const init: RequestInit = { method: req.method, headers };
      if (req.method !== 'GET' && req.body !== undefined) init.body = JSON.stringify(req.body);
      const doFetch = this.opts.fetchImpl ?? fetch;
      const res = await doFetch(url.toString(), init);
      status = res.status;
      body = await res.json().catch(() => ({}));
    } catch (e) {
      body = { error: String((e as Error).message || e) };
    }
    this.sendFrame({ type: 'data', payload: { id: req.id, status, body }, server_ts: Math.floor(Date.now() / 1000) });
  }

  private sendFrame(obj: unknown): void {
    if (!this.ws) return;
    try { this.ws.send(JSON.stringify(obj)); } catch { /* closing */ }
  }

  /**
   * 拼接 relay API 绝对路径，保留 base 的 pathname。
   * 不能用 new URL(path, base)：JS URL 解析对以 / 开头的 path 会重置 pathname，
   * 把 base 的路径前缀（如 /tunnel）丢掉 → 405/404。
   */
  private relayApiUrl(path: string): string {
    const base = new URL(this.opts.relayUrl);
    const prefix = base.pathname.replace(/\/$/, '');
    return base.origin + prefix + path;
  }

  private async api<T>(path: string, body: unknown): Promise<T> {
    const doFetch = this.opts.relayFetch ?? fetch;
    const res = await doFetch(this.relayApiUrl(path), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-relay-key': this.opts.key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401) throw new Error('relay key 被拒绝');
    if (!res.ok) throw new Error(`relay ${path} → HTTP ${res.status}`);
    const json = await res.json() as { code: number; data?: T };
    if (json.code !== 0 || !json.data) throw new Error(`relay ${path} 业务失败`);
    return json.data;
  }

  /** 测试/诊断用：当前连接是否健康 */
  healthy(): boolean {
    return this.tunnelState === 'paired' && !!this.ws;
  }
}

// 便于在测试里断言 JSON 结构（不被 tree-shake）
export const __internals = { crypto };
