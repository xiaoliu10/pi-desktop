/**
 * LAN remote control: an opt-in, token-gated HTTP+SSE server that lets a
 * phone on the same network view AND control the current workspace. No cloud
 * relay — the desktop itself is the server. Write surface is intentionally
 * narrow: prompt (queue follow-up), stop, and dialog respond — all three
 * delegate to PiBackend, which applies the same validation as the desktop IPC.
 * ZCode 的云中继 + rpc-frame 在这里的等价物 = 局域网直连 + POST 写路由 +
 * SSE 已在广播的 rpc/ui 事件（含 message_update 增量做打字机）。
 */

import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import type { PiEntry, PiEvent, PiRun, PiSession, PiUiRequest } from '../../shared/pi';
import type { PiImage } from '../../shared/composer';
import { RemoteVisibility } from './remote-visibility';
export { historyWindow, HISTORY_PAGE_SIZE } from './history-window';

export interface RemoteStatus {
  running: boolean;
  port?: number;
  token?: string;
  urls: string[];
  viewers?: number;
  /**
   * 一次性配对码（R-remote-01）。手机扫这个，不是扫 token：code 短 TTL、用后即焚，
   * 换出的 session 也是短时效，避免「URL 里长驻 token = 永久钥匙」。
   */
  pairing?: { code: string; expiresAt: number };
}

export type RemoteDialogResponse = { id: string; value?: string; confirmed?: boolean; cancelled?: boolean };

/** Data source the server renders — the same host the desktop UI uses. */
export interface RemoteDataProvider {
  sessions(): PiSession[];
  /** 已归档会话 key（桌面侧 archive.list()）：与桌面侧栏一致，手机端不展示。 */
  archivedSessions?(): string[];
  /** 已移除/隐藏项目路径（桌面侧 hiddenProjects）：与桌面侧栏一致，手机端不展示。 */
  hiddenProjects?(): string[];
  runs(): PiRun[];
  /** 一页手机端历史：窗口计算由会话索引 worker 完成（`IndexPort.remotePage`），
   *  HTTP 层只做可见性守卫与 JSON 输出。字段名与 worker 返回一致。 */
  historyPage(key: string, before: string | null): Promise<{ branch: PiEntry[]; hasMore: boolean; before: number } | null>;
  version(): string | null;
  /** Desktop 应用自身版本（app.getVersion()）：让手机端能分辨连的是哪个版本的桌面。 */
  desktopVersion?(): string;
  /** 写操作：全部委托 PiBackend（与桌面 IPC 同款校验与并发语义）。 */
  prompt(key: string, text: string, images?: PiImage[]): Promise<void> | void;
  /** 编辑历史消息：fork 截断到该条目后重发新文本（后端 forkTo + 新 prompt，空闲态校验同桌面）。 */
  editResend?(key: string, entryId: string, text: string): Promise<void>;
  stop(key: string): Promise<void> | void;
  respond(key: string, generation: string, response: RemoteDialogResponse): void;
  /** 待审批快照：页面刷新后据此恢复审批卡片。 */
  pendingDialogs(key: string): Array<{ generation: string; request: PiUiRequest }>;
}

export interface PiHistoryLite {
  branch: PiEntry[];
}

const MAX_SSE_CLIENTS = 8;
const MAX_BODY_BYTES = 64 * 1024;
/** 超限 body 也读完才回 400（见 readBody），这是中途放弃读取的硬顶。 */
const MAX_HARD_BODY_BYTES = 8 * 1024 * 1024;
const MAX_PROMPT_CHARS = 200_000;
// 仅 /api/prompt 放宽 body 顶：截图直传要走既有 backend 图片口径（总量 ≤10MiB
// base64）+ 文本/JSON 开销，11 MiB 软顶、12 MiB 硬顶；其余路径维持 64KiB。
const MAX_PROMPT_BODY_BYTES = 11 * 1024 * 1024;
const MAX_PROMPT_HARD_BODY_BYTES = 12 * 1024 * 1024;
// 远程图片校验与 backend.prompt 同口径（数量/MIME/总长），在服务端提前把关，
// 非法请求不触达 backend；数据只能随请求体而来，绝不读文件路径或拉取 URL。
const REMOTE_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_REMOTE_IMAGES = 10;
const MAX_REMOTE_IMAGE_BASE64_TOTAL = 10 * 1024 * 1024;

export class RemoteServer {
  private server: http.Server | null = null;
  private token = '';
  private port = 0;
  private sseClients = new Set<http.ServerResponse>();
  /** /api/state、/api/history 与 SSE 事件共用的可见性口径（remote-visibility.ts）。 */
  private readonly visibility: RemoteVisibility;

  constructor(private readonly data: RemoteDataProvider) {
    this.visibility = new RemoteVisibility({
      sessions: () => this.data.sessions(),
      runs: () => this.data.runs(),
      archivedSessions: () => this.data.archivedSessions?.(),
      hiddenProjects: () => this.data.hiddenProjects?.(),
    });
  }

  get running(): boolean {
    return this.server !== null;
  }

  /** Live events from the pi host are fanned out to connected viewers. */
  publish(event: PiEvent): void {
    if (!this.sseClients.size) return;
    if (event.type === 'sessions-changed') {
      // 归档/移除项目等可见性输入已变化：先失效缓存，让后续事件按新口径过滤
      // （项目在查看器打开期间被归档/移除也即时生效）。
      this.visibility.invalidate();
    } else if (!this.eventVisible(event)) {
      return; // 已移除项目 / 内部会话的事件不得让记录在手机端重现
    }
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of this.sseClients) {
      try {
        res.write(payload);
      } catch {
        this.sseClients.delete(res);
      }
    }
  }

  /** SSE 事件级可见性：判断自身出错时放行（fail-open），绝不阻断事件链路。 */
  private eventVisible(event: PiEvent): boolean {
    try {
      const visible = this.visibility.snapshot(); // TTL 缓存：流式事件高频，不做每条磁盘 IO
      switch (event.type) {
        case 'run':
          return visible.runVisible(event.run);
        case 'ui':
        case 'rpc':
        case 'closed':
        case 'compaction-record':
          return visible.keyVisible(event.key);
        default:
          return true; // sessions-changed / resources-changed 等广播型事件照发
      }
    } catch {
      return true;
    }
  }

  async start(preferredPort = 0): Promise<RemoteStatus> {
    if (this.running) return this.status();
    this.token = crypto.randomBytes(16).toString('hex');
    this.rotatePairingCode();
    const server = http.createServer((req, res) => void this.handle(req, res));
    this.server = server;
    this.port = await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(preferredPort, '0.0.0.0', () => {
        const addr = server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : preferredPort);
      });
    });
    return this.status();
  }

  async stop(): Promise<RemoteStatus> {
    const server = this.server;
    this.server = null;
    for (const res of this.sseClients) res.end();
    this.sseClients.clear();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    return this.status();
  }

  status(): RemoteStatus {
    if (!this.running) return { running: false, urls: [], viewers: 0 };
    return {
      running: true, port: this.port, token: this.token, urls: this.urls(), viewers: this.sseClients.size,
      pairing: this.pairing ? { code: this.pairing.code, expiresAt: this.pairing.expiresAt } : undefined,
    };
  }

  /** 本机 remote-server 的 base+token（tunnel-client 转发 terminal 请求时用）。未运行返回 null。 */
  lanEndpoint(): { base: string; token: string } | null {
    if (!this.running) return null;
    return { base: `http://127.0.0.1:${this.port}`, token: this.token };
  }

  /**
   * 本轮配对码。6 位数字比 32 位 hex 更好念也更短（用户可能要手输），
   * 但熵只有 ~20 bit —— 所以必须靠 TTL + 一次性 + 失败计数兜住，不能只靠码本身。
   */
  private pairing: { code: string; expiresAt: number } | null = null;
  /** 已签发的 session：token → 过期时间。短时效，过期即删。 */
  private readonly sessions = new Map<string, number>();
  /** 每个来源 IP 的失败次数与锁定截止时间（防爆破）。 */
  private readonly failures = new Map<string, { count: number; until: number }>();

  private static readonly PAIRING_TTL_MS = 120_000;
  private static readonly SESSION_TTL_MS = 12 * 60 * 60 * 1000;
  private static readonly MAX_FAILURES = 5;
  private static readonly LOCKOUT_MS = 5 * 60 * 1000;

  private rotatePairingCode(): void {
    // 用 rejection sampling 避免 % 1000000 的偏置（虽然偏置很小，但没必要留）。
    let n = 0;
    do { n = crypto.randomInt(0, 1_000_000); } while (n === this.failures.size);
    this.pairing = {
      code: String(n).padStart(6, '0'),
      expiresAt: Date.now() + RemoteServer.PAIRING_TTL_MS,
    };
  }

  private sourceOf(req: http.IncomingMessage): string {
    return req.socket.remoteAddress ?? 'unknown';
  }

  private locked(req: http.IncomingMessage): boolean {
    const f = this.failures.get(this.sourceOf(req));
    return !!f && f.until > Date.now();
  }

  private noteFailure(req: http.IncomingMessage): void {
    const ip = this.sourceOf(req);
    const prev = this.failures.get(ip);
    const count = (prev && prev.until > Date.now() ? prev.count : 0) + 1;
    this.failures.set(ip, {
      count,
      until: count >= RemoteServer.MAX_FAILURES ? Date.now() + RemoteServer.LOCKOUT_MS : 0,
    });
  }

  /** 一次性配对码换短时效 session；码用后即焚，换出新的。 */
  private exchangePairing(req: http.IncomingMessage, code: string): { session: string; expiresAt: number } | null {
    const expected = this.pairing;
    if (!expected || expected.expiresAt <= Date.now()) return null;
    // 定长比较（两个 6 位数字串），避免按字符提前返回泄漏前缀。
    const a = Buffer.from(code.padEnd(6, '\0'));
    const b = Buffer.from(expected.code.padEnd(6, '\0'));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const session = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + RemoteServer.SESSION_TTL_MS;
    this.sessions.set(session, expiresAt);
    this.rotatePairingCode();
    this.failures.delete(this.sourceOf(req));
    return { session, expiresAt };
  }

  /** 校验收到的凭证：既认长期 token（迁移期），也认短时效 session。 */
  private matchCredential(supplied: string): boolean {
    if (!supplied) return false;
    if (supplied.length === this.token.length
      && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(this.token))) return true;
    const expiresAt = this.sessions.get(supplied);
    if (expiresAt === undefined) return false;
    if (expiresAt <= Date.now()) { this.sessions.delete(supplied); return false; }
    return true;
  }

  /** LAN view links, one per non-internal IPv4 interface. */
  urls(): string[] {
    if (!this.running) return [];
    const out: string[] = [];
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list ?? []) {
        if (ni.family === 'IPv4' && !ni.internal) {
          out.push(`http://${ni.address}:${this.port}/view?token=${this.token}`);
        }
      }
    }
    if (!out.length) out.push(`http://127.0.0.1:${this.port}/view?token=${this.token}`);
    return out;
  }

  private authorize(req: http.IncomingMessage, url: URL): boolean {
    // URL query token 仅作迁移期兼容（旧二维码/旧书签），新链路一律走 Authorization 头。
    const candidates = [url.searchParams.get('token') ?? ''];
    const header = req.headers.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) candidates.push(header.slice(7));
    for (const supplied of candidates) if (this.matchCredential(supplied)) return true;
    return false;
  }

  private readBody(req: http.IncomingMessage, limits: { soft: number; hard: number }): Promise<{ raw: string; bytes: number }> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let overflow = false;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > limits.soft) {
          // 超限后继续把 body 读完再拒（边读边 destroy 会让客户端拿到
          // ECONNRESET 而不是 400 响应）；只丢弃内容，硬顶防恶意灌流。
          overflow = true;
          chunks.length = 0;
          if (size > limits.hard) { req.destroy(); reject(new Error('请求体过大')); }
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (overflow) { reject(new Error('请求体过大')); return; }
        const buffer = Buffer.concat(chunks);
        resolve({ raw: buffer.toString('utf8'), bytes: buffer.length });
      });
      req.on('error', reject);
    });
  }

  private json(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  private isRun(key: unknown): key is string {
    return typeof key === 'string' && key.length > 0 && this.data.runs().some((r) => r.key === key);
  }

  private async handlePost(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const path = url.pathname;
    if (!['/api/prompt', '/api/stop', '/api/respond', '/api/edit'].includes(path)) {
      this.json(res, 404, { error: 'not found' });
      return;
    }
    let body: Record<string, unknown>;
    let rawBytes = 0;
    try {
      // 鉴权已在 handle() 里先行完成；这里才读 body。只有 /api/prompt 允许带图的大 body，其余路径维持 64KiB。
      const limits = path === '/api/prompt'
        ? { soft: MAX_PROMPT_BODY_BYTES, hard: MAX_PROMPT_HARD_BODY_BYTES }
        : { soft: MAX_BODY_BYTES, hard: MAX_HARD_BODY_BYTES };
      const read = await this.readBody(req, limits);
      rawBytes = read.bytes;
      body = JSON.parse(read.raw || '{}') as Record<string, unknown>;
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('请求体必须是 JSON 对象');
    } catch (e) {
      this.json(res, 400, { error: String((e as Error).message || e) });
      return;
    }
    try {
      if (path === '/api/prompt') {
        const key = body.key;
        if (!this.isRun(key)) { this.json(res, 404, { error: '会话未连接' }); return; }
        // 图片先行校验（形状/MIME/canonical base64/数量/总长），非法不触达 backend；
        // 归一化成 backend 期望的精确形状 {type:'image',mimeType,data}。
        let images: PiImage[];
        try {
          images = normalizeRemoteImages(body.images);
        } catch (e) {
          this.json(res, 400, { error: String((e as Error).message || e) });
          return;
        }
        // 无图请求维持既有 64KiB body 顶（含老的超长文本拒绝口径）；带图时文本仍
        // 受 200k 字符限制。纯图片发送允许不带 text（桌面端同场景会补说明文字，
        // 空文本的最终校验口径在 backend）。
        const text = typeof body.text === 'string' ? body.text : '';
        if ((!images.length && !text.trim()) || text.length > MAX_PROMPT_CHARS) { this.json(res, 400, { error: '消息为空或超过 200000 字符' }); return; }
        if (!images.length && rawBytes > MAX_BODY_BYTES) { this.json(res, 400, { error: '请求体过大' }); return; }
        if (images.length) await this.data.prompt(key, text, images);
        else await this.data.prompt(key, text); // 无图保持既有两参调用形状
        this.json(res, 200, { ok: true });
        return;
      }
      if (path === '/api/edit') {
        const key = body.key, entryId = body.entryId, text = typeof body.text === 'string' ? body.text : '';
        if (!this.isRun(key)) { this.json(res, 404, { error: '会话未连接' }); return; }
        if (typeof entryId !== 'string' || !entryId) { this.json(res, 400, { error: '消息条目无效' }); return; }
        if (!text.trim()) { this.json(res, 400, { error: '内容为空' }); return; }
        if (!this.data.editResend) { this.json(res, 501, { error: '当前桌面版本不支持编辑消息' }); return; }
        await this.data.editResend(key, entryId, text);
        this.json(res, 200, { ok: true });
        return;
      }
      if (path === '/api/stop') {
        if (!this.isRun(body.key)) { this.json(res, 404, { error: '会话未连接' }); return; }
        await this.data.stop(body.key);
        this.json(res, 200, { ok: true });
        return;
      }
      // /api/respond
      if (!this.isRun(body.key)) { this.json(res, 404, { error: '会话未连接' }); return; }
      if (typeof body.generation !== 'string' || !body.generation) { this.json(res, 400, { error: '缺少 generation' }); return; }
      const response = body.response;
      if (!response || typeof response !== 'object' || Array.isArray(response) || typeof (response as RemoteDialogResponse).id !== 'string') { this.json(res, 400, { error: 'response 形状无效' }); return; }
      const r = response as RemoteDialogResponse;
      const valueOk = r.value === undefined || typeof r.value === 'string';
      const confirmedOk = r.confirmed === undefined || typeof r.confirmed === 'boolean';
      const cancelledOk = r.cancelled === undefined || typeof r.cancelled === 'boolean';
      const hasPayload = r.value !== undefined || r.confirmed !== undefined || r.cancelled !== undefined;
      if (!valueOk || !confirmedOk || !cancelledOk || !hasPayload) { this.json(res, 400, { error: 'response 形状无效' }); return; }
      this.data.respond(body.key, body.generation, r);
      this.json(res, 200, { ok: true });
    } catch (e) {
      // backend 抛出的业务错误（已过期/不在可发送状态等）原样回给页面。
      this.json(res, 400, { error: String((e as Error).message || e) });
    }
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://local');
      const method = req.method ?? 'GET';
      if (method !== 'GET' && method !== 'POST') {
        res.writeHead(405, { 'allow': 'GET, POST' });
        res.end('method not allowed');
        return;
      }
      if (method === 'POST' && url.pathname === '/api/pair') {
        // 配对必须在鉴权前：换 session 的前提就是还没有任何凭证。
        // 失败计数与锁定在这里生效，防 6 位码被爆破（~20 bit 熵不能单靠码本身）。
        if (this.locked(req)) { this.json(res, 429, { error: '尝试次数过多，请稍后再试' }); return; }
        let code = '';
        try {
          const read = await this.readBody(req, { soft: MAX_BODY_BYTES, hard: MAX_HARD_BODY_BYTES });
          const body = JSON.parse(read.raw || '{}') as { code?: unknown };
          code = typeof body.code === 'string' ? body.code.trim() : '';
        } catch {
          this.json(res, 400, { error: '请求体无效' });
          return;
        }
        const issued = this.exchangePairing(req, code);
        if (!issued) {
          this.noteFailure(req);
          this.json(res, 401, { error: '配对码无效或已过期' });
          return;
        }
        this.json(res, 200, issued);
        return;
      }
      if (!this.authorize(req, url)) {
        res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('unauthorized');
        return;
      }
      if (method === 'POST') {
        await this.handlePost(req, res, url);
        return;
      }
      switch (url.pathname) {
        case '/view':
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          res.end(viewerPage());
          return;
        case '/api/state': {
          // 归档索引损坏等异常在 RemoteVisibility 内部降级为「不过滤」，保证页面可用
          // 而不是让整个 /api/state 变 500。偏好是动态的：每次强制现算，不读缓存。
          const visible = this.visibility.snapshot(true);
          this.json(res, 200, {
            version: this.data.version(),
            desktopVersion: this.data.desktopVersion?.() ?? null,
            sessions: lightSessions(this.data.sessions().filter(s => visible.sessionVisible(s))),
            runs: lightRuns(this.data.runs().filter(r => visible.runVisible(r)), (key) => this.data.pendingDialogs(key)),
          });
          return;
        }
        case '/api/history': {
          const key = url.searchParams.get('session') ?? '';
          // 与 /api/state 同口径的可见性守卫（不变）：已归档 / 已移除项目 / 内部会话的
          // 逐条历史不能因为拿到 key 就在手机端读出来；404 与「会话不存在」同形，不
          // 泄露存在性。索引损坏时 snapshot 内部降级为不过滤（恢复页面可用）。
          const readable = !!key && this.visibility.snapshot(true).keyVisible(key);
          // tail 懒加载：默认只回最近一页 + hasMore + before（分支内索引游标）；
          // ?before=N 取 N 之前更早的一页。窗口计算在会话索引 worker 内（historyWindow），
          // 这里不再自己算：主进程拿到的只是已经裁好的有界一页。可见性守卫在 tail
          // 模式下同样生效（不可见会话 404）。
          const page = readable ? await this.data.historyPage(key, url.searchParams.get('before')) : null;
          if (!page) {
            res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            res.end(JSON.stringify({ error: 'unknown session' }));
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          res.end(JSON.stringify({ branch: page.branch, hasMore: page.hasMore, before: page.before }));
          return;
        }
        case '/api/events': {
          if (this.sseClients.size >= MAX_SSE_CLIENTS) {
            res.writeHead(503);
            res.end('too many viewers');
            return;
          }
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
          res.write(`data: ${JSON.stringify({ type: 'hello' })}\n\n`);
          this.sseClients.add(res);
          req.on('close', () => this.sseClients.delete(res));
          return;
        }
        default:
          res.writeHead(404);
          res.end('not found');
      }
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end('error');
    }
  }
}

/** 手机端列表投影：与桌面侧栏同口径的过滤（归档/隐藏项目/内部会话）已由 VisibilitySnapshot 完成，这里只做裁剪与排序。 */
function lightSessions(sessions: PiSession[]) {
  return sessions
    .map((s) => ({ key: s.key, name: s.name, cwd: s.cwd, updatedAt: s.updatedAt, owned: s.owned }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 200);
}

function isCanonicalBase64(data: string): boolean {
  // 严格 canonical base64：字母表受限、长度 4 的倍数、padding 位置正确，且
  // Node 重编码后与原文逐字一致（「AB==」这类尾位非零的编码会被拒）。
  if (!data.length || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return false;
  return Buffer.from(data, 'base64').toString('base64') === data;
}

/**
 * 校验并规范化远程 prompt 的图片数组。只接受随请求体而来的内联数据：
 * 每张必须是对象（type 若给必须是 'image'）、受支持 MIME、严格 canonical base64；
 * 未知字段（url/path/file 等）一律拒绝 —— 服务器绝不读文件路径或拉取远程 URL。
 * 数量 ≤10、base64 总长 ≤10MiB，与 backend.prompt 的既有口径一致。
 */
function normalizeRemoteImages(input: unknown): PiImage[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new Error('图片格式无效');
  if (input.length > MAX_REMOTE_IMAGES) throw new Error(`一次最多添加 ${MAX_REMOTE_IMAGES} 张图片`);
  const out: PiImage[] = [];
  let total = 0;
  for (const item of input) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('图片格式无效');
    const record = item as Record<string, unknown>;
    for (const field of Object.keys(record)) {
      if (field !== 'type' && field !== 'mimeType' && field !== 'data') throw new Error(`图片字段无效：${field}`);
    }
    if (record.type !== undefined && record.type !== 'image') throw new Error('图片格式无效');
    if (typeof record.mimeType !== 'string' || !REMOTE_IMAGE_MIMES.has(record.mimeType)) throw new Error('不支持的图片格式');
    if (typeof record.data !== 'string' || !isCanonicalBase64(record.data)) throw new Error('图片数据必须是有效的 base64');
    total += record.data.length;
    if (total > MAX_REMOTE_IMAGE_BASE64_TOTAL) throw new Error('图片总大小超过 10 MiB，请减少图片');
    out.push({ type: 'image', mimeType: record.mimeType, data: record.data });
  }
  return out;
}

function lightRuns(runs: PiRun[], dialogs: (key: string) => Array<{ generation: string; request: PiUiRequest }> = () => []) {
  return runs.map((r) => ({ key: r.key, status: r.status, cwd: r.cwd, pending: r.pending, error: r.error, model: r.model?.name, generation: r.generation, dialogs: dialogs(r.key) }));
}

/** Single-file mobile viewer. Parse of pi entries mirrors the desktop's historyToMessages minimally. */
export function viewerPage(): string {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<title>PI Desktop · 远程控制</title>
<style>
  :root { color-scheme: light dark; --bg:#f4f4f6; --card:#fff; --line:#e3e3e6; --text:#1c1c1e; --sub:#8a8a90; --accent:#1d1d1f; --user:#e8f0fe; --danger:#ba4236; --chip:#eeeef0; }
  @media (prefers-color-scheme: dark) { :root { --bg:#121316; --card:#212226; --line:#323338; --text:#ececef; --sub:#9a9aa2; --accent:#f2f2f3; --user:#1f2a3d; --danger:#ff6b61; --chip:#2c2d31; } }
  * { box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
  [hidden] { display:none !important; }
  body { margin:0; background:var(--bg); color:var(--text); font:15px/1.55 -apple-system,"PingFang SC",system-ui,sans-serif; }
  header { position:sticky; top:0; z-index:5; background:var(--card); border-bottom:1px solid var(--line); padding:14px 16px 10px; }
  .head-row { display:flex; align-items:center; gap:10px; }
  .head-row h1 { font-size:19px; margin:0; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .head-sub { font-size:13px; color:var(--sub); margin:2px 0 0; }
  .backbtn { border:0; background:none; color:var(--text); font-size:22px; line-height:1; padding:2px 8px 2px 0; display:none; }
  .pill { font-size:11px; padding:3px 10px; border-radius:99px; border:1px solid var(--line); color:var(--sub); flex-shrink:0; }
  .pill.live { color:#0a7d33; border-color:#0a7d3355; }
  .pill.err { color:var(--danger); border-color:var(--danger); }
  .stopbtn { flex-shrink:0; border:1px solid var(--danger); color:var(--danger); background:none; border-radius:8px; font-size:12px; padding:5px 10px; display:none; }
  main { padding:14px 14px 150px; }
  .notice { background:var(--chip); border-radius:12px; padding:12px 14px; font-size:13px; color:var(--sub); margin-bottom:18px; }
  .sect-head { display:flex; align-items:center; gap:10px; margin:2px 2px 2px; }
  .sect-head h2 { font-size:17px; margin:0; flex:1; }
  .refreshbtn { border:1px solid var(--line); background:none; color:var(--text); border-radius:10px; padding:6px 12px; font-size:13px; }
  .sect-sub { color:var(--sub); font-size:13px; margin:2px 2px 12px; }
  .proj-search { width:100%; border:1px solid var(--line); background:var(--card); color:var(--text); border-radius:10px; padding:9px 12px; font:inherit; font-size:14px; margin-bottom:12px; }
  .proj { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:12px; margin-bottom:12px; display:flex; align-items:center; gap:12px; }
  .proj-icon { flex:0 0 42px; height:42px; border-radius:10px; background:var(--chip); display:flex; align-items:center; justify-content:center; font-size:19px; }
  .proj-main { flex:1; min-width:0; cursor:pointer; }
  .proj-name { font-size:15px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .proj-tag { font-size:10px; padding:1px 8px; border:1px solid var(--line); border-radius:99px; color:var(--sub); margin-left:8px; vertical-align:2px; }
  .proj-path { font-size:12px; color:var(--sub); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:ui-monospace,Menlo,monospace; }
  .proj-meta { display:flex; gap:10px; font-size:12px; color:var(--sub); margin-top:3px; }
  .proj-meta .go { margin-left:auto; }
  .proj-add { flex:0 0 38px; height:38px; border:1px solid var(--line); background:none; color:var(--text); border-radius:10px; font-size:19px; line-height:1; }
  .proj.go-live { border-color:#0a7d3355; }
  .proj.go-live .proj-meta { color:#0a7d33; }
  .pending-badge { color:#c47f17; }
  .footnote { text-align:center; color:var(--sub); font-size:11px; margin:26px 0 0; }
  .empty { text-align:center; color:var(--sub); padding:48px 0; font-size:13px; }
  .conn { text-align:center; color:var(--sub); font-size:11px; padding:6px 0 14px; }
  select { appearance:none; background:var(--card); color:var(--text); border:1px solid var(--line); border-radius:8px; padding:6px 8px; max-width:52vw; font-size:13px; }
  .chat-bar { display:flex; gap:8px; align-items:center; margin-bottom:6px; }
  .msg { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:10px 12px; margin:8px 0; overflow-wrap:anywhere; white-space:pre-wrap; }
  .msg.user { background:var(--user); }
  .msg.pending { opacity:.6; }
  .msg .who { font-size:11px; color:var(--sub); margin-bottom:4px; }
  .msg.tool { color:var(--sub); font-size:13px; }
  .msg.think { color:var(--sub); font-size:13px; font-style:italic; }
  .msg.think details { margin-top:2px; }
  .msg.think summary { color:var(--sub); cursor:pointer; font-size:12px; font-style:normal; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .msg.think summary:hover { color:var(--text); }
  .think-body { white-space:pre-wrap; font-style:normal; margin-top:6px; max-height:50vh; overflow:auto; border-top:1px dashed var(--line); padding-top:6px; }
  .msg.err { color:var(--danger); border-color:var(--danger); }
  .composer { position:fixed; left:0; right:0; bottom:0; z-index:3; background:var(--card); border-top:1px solid var(--line); padding:8px 10px calc(8px + env(safe-area-inset-bottom)); display:flex; flex-direction:column; gap:6px; align-items:stretch; }
  .composer-row { display:flex; gap:8px; align-items:flex-end; }
  .imgbtn { flex-shrink:0; border:1px solid var(--line); background:var(--bg); color:var(--text); border-radius:10px; font-size:17px; line-height:1; padding:10px 11px; cursor:pointer; user-select:none; -webkit-user-select:none; }
  .imgbtn[aria-disabled="true"] { opacity:.4; pointer-events:none; }
  .img-chips { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
  .chip { display:inline-flex; align-items:center; gap:6px; background:var(--chip); border:1px solid var(--line); border-radius:99px; padding:4px 6px 4px 10px; font-size:12px; max-width:100%; }
  .chip .chip-name { max-width:110px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .chip .chip-size { color:var(--sub); font-size:11px; flex-shrink:0; }
  .chip-x { border:0; background:none; color:var(--sub); font-size:13px; line-height:1; padding:2px 4px; cursor:pointer; }
  .chips-total { font-size:11px; color:var(--sub); }
  .msg-edit { margin-left:8px; border:1px solid var(--line); background:none; color:var(--sub); border-radius:8px; font-size:11px; padding:1px 8px; }
  .msg-edit:active { color:var(--accent); border-color:var(--accent); }
  .msg .who { display:flex; align-items:center; }
  .composer.editing textarea { border-color:var(--accent); }
  .composer textarea { flex:1; resize:none; border:1px solid var(--line); background:var(--bg); color:var(--text); border-radius:10px; padding:9px 10px; font:inherit; font-size:16px; max-height:120px; min-height:38px; }
  .composer-row .sendbtn { font-size:14px; }
  .composer textarea:disabled { opacity:.5; }
  .sendbtn { flex-shrink:0; border:0; background:var(--accent); color:var(--bg); border-radius:10px; font-size:14px; padding:9px 16px; }
  .sendbtn:disabled { opacity:.4; }
  .dialogs { position:fixed; left:10px; right:10px; bottom:calc(64px + env(safe-area-inset-bottom)); z-index:4; }
  .dialog-card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:14px; box-shadow:0 8px 30px rgba(0,0,0,.18); }
  .dialog-card .dlg-title { font-size:13px; color:var(--sub); margin-bottom:4px; }
  .dialog-card .dlg-msg { font-size:14px; margin-bottom:10px; overflow-wrap:anywhere; white-space:pre-wrap; max-height:30vh; overflow:auto; }
  .dialog-card .dlg-opts { display:flex; flex-direction:column; gap:8px; }
  .dlg-opt { border:1px solid var(--line); background:var(--bg); color:var(--text); border-radius:10px; padding:10px 12px; font:inherit; font-size:14px; text-align:left; }
  .dlg-opt b { display:block; }
  .dlg-opt small { color:var(--sub); font-size:12px; }
  .dlg-row { display:flex; gap:8px; margin-top:10px; }
  .dlg-row .dlg-primary { flex:1; border:0; background:var(--accent); color:var(--bg); border-radius:10px; padding:10px; font:inherit; font-size:14px; }
  .dlg-row .dlg-ghost { border:1px solid var(--line); background:none; color:var(--text); border-radius:10px; padding:10px 14px; font:inherit; font-size:14px; }
  .dialog-card input, .dialog-card textarea { width:100%; border:1px solid var(--line); background:var(--bg); color:var(--text); border-radius:10px; padding:10px; font:inherit; font-size:14px; }
  .ask-multi { font-size:11px; color:var(--sub); margin-left:6px; }
  .loadolder { display:block; margin:0 auto 12px; border:1px solid var(--line); background:var(--card); color:var(--text); border-radius:99px; padding:7px 18px; font:inherit; font-size:13px; }
  .loadolder:disabled { opacity:.5; }
</style>
</head>
<body>
<header>
  <div class="head-row">
    <button class="backbtn" id="back" aria-label="返回">&#8249;</button>
    <h1 id="title">PI Desktop 远程控制</h1>
    <span class="pill" id="status">离线</span>
    <button class="stopbtn" id="stopbtn">停止</button>
  </div>
  <p class="head-sub" id="subtitle">已连接到当前桌面窗口</p>
</header>
<main id="projects">
  <div class="notice">本次连接可以查看当前设备上已打开的项目、任务和会话；二维码失效后需要回到桌面端重新连接。</div>
  <div class="sect-head"><h2>当前设备上的工作区和任务</h2><button class="refreshbtn" id="refresh">&#8635; 刷新</button></div>
  <div class="sect-sub" id="projStat">读取中…</div>
  <input class="proj-search" id="projSearch" placeholder="搜索项目或任务…">
  <div id="projList"></div>
  <div class="footnote">本地执行 · 数据不会离开你的电脑</div>
</main>
<main id="chat" hidden>
  <div class="chat-bar">
    <select id="session"></select>
  </div>
  <div id="feed"><div class="empty">正在连接桌面端…</div></div>
</main>
<div class="dialogs" id="dialogs" hidden></div>
<form class="composer" id="composer" hidden>
  <div class="img-chips" id="imgChips" hidden></div>
  <div class="composer-row">
    <input type="file" id="imgInput" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden>
    <label class="imgbtn" id="imgBtn" for="imgInput" aria-label="添加图片">&#128247;</label>
    <textarea id="input" rows="1" placeholder="连接桌面端后可发送…" disabled></textarea>
    <button class="sendbtn" id="send" type="submit" disabled>发送</button>
  </div>
</form>
<div class="conn" id="conn"></div>
<script>
const qs = new URLSearchParams(location.search);
const TOKEN = qs.get('token') || '';
const api = (p) => fetch(p + (p.includes('?') ? '&' : '?') + 'token=' + TOKEN).then(r => { if (r.status === 401) throw new Error('token'); return r.json(); });
function post(p, body) {
  return fetch(p + '?token=' + TOKEN, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; });
}
let sessions = [], runs = new Map(), current = null, reconnectTimer = null;
let chatView = false;
// id → { key, generation, request }；页面刷新后由 /api/state 的 runs[].dialogs 恢复。
let dialogs = new Map();
// 流式打字机：当前会话正在拼装的助手消息块（等价桌面 stream-delta）。
let liveBlocks = null;
// 乐观发送：POST 成功但历史尚未回显的用户消息。match 用于与历史文本对账（回显后
// 移除），display 是气泡文案（带图时首行加「📷 n 张」）。
let optimistic = [];
// 历史懒加载：viewPages 按分支内绝对索引存放已加载条目（默认只拉最近 50 条，
// 上滑到顶点「加载更早」用 before 游标 prepend 更早的一页）。回合结束 / 切会话
// 只重拉 tail；olderCursor 随会话切换重置。
let viewPages = new Map();
let olderCursor = null;     // 「加载更早」下一页游标（分支内索引；null = 没有更早）
let olderLoading = false;  // 「加载更早」防重入

function escapeHtml(s) { return String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }

// ---- 项目视图（ZCode 同款：扫码进来是工作区卡片列表） ----
function projects() {
  const map = new Map();
  for (const s of sessions) {
    const cwd = s.cwd || '其他';
    if (!map.has(cwd)) map.set(cwd, { cwd, name: (cwd.split(/[\\\\/]/).filter(Boolean).pop() || cwd), sessions: [], latest: 0 });
    const g = map.get(cwd);
    g.sessions.push(s);
    g.latest = Math.max(g.latest, s.updatedAt || 0);
  }
  return [...map.values()].sort((a, b) => b.latest - a.latest);
}
let stateLoaded = false;
function renderProjects() {
  const q = (document.getElementById('projSearch').value || '').toLowerCase();
  if (!stateLoaded) {
    document.getElementById('projStat').textContent = '读取中…';
    document.getElementById('projList').innerHTML = '<div class="empty">正在连接桌面端…</div>';
    return;
  }
  const groups = projects();
  document.getElementById('projStat').textContent = groups.length + ' 个工作区 · ' + sessions.length + ' 个任务';
  const list = document.getElementById('projList');
  const visible = groups.filter(g => !q || g.name.toLowerCase().includes(q) || g.cwd.toLowerCase().includes(q) || g.sessions.some(s => (s.name || '').toLowerCase().includes(q)));
  if (!visible.length) { list.innerHTML = '<div class="empty">没有匹配的项目</div>'; return; }
  list.innerHTML = visible.map(g => {
    const live = g.sessions.some(s => { const r = runs.get(s.key); return r && (r.status === 'running' || r.status === 'starting'); });
    const keys = new Set(g.sessions.map(x => x.key));
    const pending = [...dialogs.values()].filter(d => keys.has(d.key)).length;
    return '<div class="proj' + (live ? ' go-live' : '') + '" data-open="' + encodeURIComponent(g.cwd) + '">'
      + '<div class="proj-icon">&#128193;</div>'
      + '<div class="proj-main">'
      + '<div class="proj-name">' + escapeHtml(g.name) + '<span class="proj-tag">本地</span></div>'
      + '<div class="proj-path">' + escapeHtml(g.cwd) + '</div>'
      + '<div class="proj-meta"><span>' + g.sessions.length + ' 个任务</span>' + (live ? '<span>运行中</span>' : '') + (pending ? '<span class="pending-badge">' + pending + ' 待审批</span>' : '') + '<span class="go">&#8250;</span></div>'
      + '</div>'
      + '<button class="proj-add" aria-label="新建任务">+</button>'
      + '</div>';
  }).join('');
}
document.getElementById('projList').addEventListener('click', e => {
  const target = e.target.closest('[data-open]');
  if (!target) return;
  const cwd = decodeURIComponent(target.getAttribute('data-open'));
  const group = projects().find(g => g.cwd === cwd);
  const latest = group && group.sessions.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
  if (latest) showChat(latest.key, true);
});
document.getElementById('projSearch').addEventListener('input', renderProjects);
document.getElementById('refresh').addEventListener('click', () => loadState());

// ---- 视图切换 ----
function showProjects() {
  chatView = false;
  document.getElementById('projects').hidden = false;
  document.getElementById('chat').hidden = true;
  document.getElementById('composer').hidden = true;
  document.getElementById('back').style.display = 'none';
  document.getElementById('title').textContent = 'PI Desktop 远程控制';
  document.getElementById('subtitle').textContent = '已连接到当前桌面窗口';
  document.getElementById('stopbtn').style.display = 'none';
  projectsPill();
  renderDialog(); // 清掉对话视图残留的审批 overlay
  renderProjects();
}
// 项目视图的聚合状态 pill：按 runs 统计运行数（不从界面文案反推）。
function projectsPill() {
  const el = document.getElementById('status');
  const running = [...runs.values()].filter(r => r.status === 'running' || r.status === 'starting').length;
  el.className = 'pill' + (running ? ' live' : '');
  el.textContent = running ? running + ' 个运行中' : '空闲';
}
function showChat(key, focusInput) {
  chatView = true;
  current = key; liveBlocks = null; optimistic = []; resetHistoryState();
  document.getElementById('projects').hidden = true;
  document.getElementById('chat').hidden = false;
  document.getElementById('composer').hidden = false;
  document.getElementById('back').style.display = 'inline-block'; // CSS 默认 none，需显式显示
  // 会话选择器只列同项目（cwd）的会话，避免长下拉找不到项目（ZCode 项目→任务两级结构）。
  const mine = sessions.find(s => s.key === key);
  const cwd = mine ? mine.cwd : null;
  const sel = document.getElementById('session');
  sel.innerHTML = '';
  for (const s of sessions.filter(x => !cwd || x.cwd === cwd)) {
    const o = document.createElement('option');
    o.value = s.key; o.textContent = s.name || s.key;
    if (s.key === current) o.selected = true;
    sel.appendChild(o);
  }
  loadHistory(); renderDialog(); renderComposer(); statusPill();
  if (focusInput) setTimeout(() => { const ta = document.getElementById('input'); ta.focus(); }, 60);
}
document.getElementById('back').addEventListener('click', showProjects);
document.getElementById('session').addEventListener('change', e => {
  current = e.target.value; liveBlocks = null; optimistic = []; resetHistoryState();
  loadHistory(); renderDialog(); renderComposer(); statusPill();
});// 「加载更早」按钮在 feed 顶部，render 重建 innerHTML 后仍是同 id；用事件代理接住点击。
document.getElementById('feed').addEventListener('click', e => {
  if (e.target.id === 'loadOlder') loadOlder();
});
function statusPill() {
  const el = document.getElementById('status');
  const mine = current && runs.get(current);
  const st = mine ? mine.status : 'idle';
  const active = st === 'running' || st === 'starting';
  el.className = 'pill' + (active ? ' live' : st === 'error' ? ' err' : '');
  let label = active ? '运行中' : st === 'error' ? '出错' : st === 'stopping' ? '停止中' : '空闲';
  if (active && mine && mine.pending > 0) label += ' · 排队 ' + mine.pending;
  el.textContent = label;
  if (chatView) {
    const s = sessions.find(x => x.key === current);
    const group = s && projects().find(g => g.cwd === s.cwd);
    document.getElementById('title').textContent = (group && group.name) || '工作区';
    document.getElementById('subtitle').textContent = s ? (s.name || s.key) : '';
    document.getElementById('stopbtn').style.display = mine && ['running', 'starting', 'stopping'].includes(st) ? '' : 'none';
  }
}

function renderComposer() {
  const mine = current && runs.get(current);
  const ta = document.getElementById('input'), btn = document.getElementById('send');
  const ok = !!mine;
  ta.disabled = !ok; btn.disabled = !ok;
  // 附件按钮随输入框一起禁用（未连接/已停止接收的会话不给发图）。
  document.getElementById('imgInput').disabled = !ok;
  document.getElementById('imgBtn').setAttribute('aria-disabled', ok ? 'false' : 'true');
  ta.placeholder = ok ? '发消息…（Enter 发送，Shift+Enter 换行）' : '该会话未连接（在桌面端打开后可发送）';
}

// ---- 历史渲染 + 乐观气泡 ----
// entries 形参保留兼容（乐观发送路径传 null）；渲染源是 viewPages（懒加载窗口，
// 按分支内绝对索引排序）。opts.preserve=true 时不自动滚底（「加载更早」prepend 后由调用方做滚动位置补偿）。
function render(entries, opts) {
  const feed = document.getElementById('feed');
  const idxs = viewPages.size ? Array.from(viewPages.keys()).sort((a, b) => a - b) : [];
  const out = [];
  const seenUser = new Set();
  for (const i of idxs) {
    const e = viewPages.get(i);
    if (!e || e.type !== 'message' || !e.message) continue;
    const m = e.message, role = m.role || '';
    if (role === 'user') { const t = textOf(m.content); seenUser.add(t); out.push(bubble('用户', t, 'user', e.id)); }
    else if (role === 'assistant') {
      if (typeof m.content === 'string') out.push(bubble('助手', m.content, ''));
      else if (Array.isArray(m.content)) for (const b of m.content) {
        if (b && b.type === 'text' && b.text) out.push(bubble('助手', b.text, ''));
        else if (b && b.type === 'thinking' && b.thinking) out.push(thinkBubble(b.thinking, false));
        else if (b && b.type === 'toolCall') out.push(bubble('工具 · ' + (b.name || 'tool'), previewArgs(b.arguments), 'tool'));
      }
      if (m.errorMessage) out.push(bubble('错误', m.errorMessage, 'err'));
    } else if (role === 'toolResult') {
      const t = textOf(m.content).split('\\n')[0] || '';
      if (t) out.push(bubble('结果', t, 'tool'));
    }
  }
  optimistic = optimistic.filter(o => !seenUser.has(o.match));
  for (const o of optimistic) out.push(bubble('用户', o.display, 'user pending'));
  // 有更早历史且视图非空时，顶部渲染「加载更早」按钮（防重入期间禁用）。
  const btn = (olderCursor !== null && idxs.length)
    ? '<button class="loadolder" id="loadOlder"' + (olderLoading ? ' disabled' : '') + '>加载更早</button>'
    : '';
  feed.innerHTML = btn + (out.length ? out.join('') : '<div class="empty">这个会话还没有内容</div>');
  if (!opts || !opts.preserve) window.scrollTo(0, document.body.scrollHeight);
}
function bubble(who, text, cls, entryId) {
  const body = escapeHtml(String(text ?? '')).slice(0, 8000);
  if (!entryId || cls === 'user pending') return '<div class="msg ' + cls + '"><div class="who">' + escapeHtml(who) + '</div>' + body + '</div>';
  return '<div class="msg ' + cls + '" data-entry="' + escapeHtml(entryId) + '"><div class="who">' + escapeHtml(who)
    + '<button type="button" class="msg-edit" data-edit="' + escapeHtml(entryId) + '" title="编辑并重发（会截断该消息之后的对话）">编辑</button></div>'
    + body + '</div>';
}
/** 思考折叠气泡：流式中只留一行状态 + 最新片段预览（默认收起，点开看全文），完成后折叠为「已思考」。 */
function thinkBubble(text, streaming) {
  const t = String(text ?? '');
  const who = streaming ? '思考中…' : '已思考';
  const summary = streaming ? escapeHtml(t.slice(-80)) : '展开思考过程（' + t.length + ' 字）';
  const MAX_THINK_CHARS = 20000;
  const body = t.length > MAX_THINK_CHARS ? t.slice(0, MAX_THINK_CHARS) + '\\n…（已截断，完整内容见桌面端）' : t;
  return '<div class="msg think"><div class="who">' + who + '（' + t.length + ' 字）</div>'
    + '<details><summary>' + summary + '</summary><div class="think-body">' + escapeHtml(body) + '</div></details></div>';
}
function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(b => b && b.type === 'text').map(b => b.text).join('');
  return '';
}
function previewArgs(args) {
  if (args && typeof args === 'object') {
    const v = args.command || args.cmd || args.file || args.path || args.pattern;
    if (typeof v === 'string') return v.split('\\n')[0];
    try { return JSON.stringify(args).slice(0, 200); } catch { return ''; }
  }
  return String(args ?? '');
}

// ---- 流式打字机（桌面 stream-delta.ts 的等价精简版） ----
function applyDelta(delta) {
  const type = String(delta.type || '');
  const index = Math.max(0, Number(delta.contentIndex || 0));
  if (type === 'start') { liveBlocks = []; return false; }
  if (!liveBlocks) liveBlocks = [];
  const ensure = (init) => {
    while (liveBlocks.length <= index) liveBlocks.push({});
    const cur = liveBlocks[index];
    if (!cur || typeof cur !== 'object' || cur.type === undefined) liveBlocks[index] = Object.assign({}, init);
    return liveBlocks[index];
  };
  if (type === 'text_start') ensure({ type: 'text', text: '' });
  else if (type === 'text_delta') { const b = ensure({ type: 'text', text: '' }); b.text = String(b.text || '') + String(delta.delta || ''); }
  else if (type === 'text_end') { const b = ensure({ type: 'text', text: '' }); b.text = String(delta.content || b.text || ''); }
  else if (type === 'thinking_start') ensure({ type: 'thinking', thinking: '' });
  else if (type === 'thinking_delta') { const b = ensure({ type: 'thinking', thinking: '' }); b.thinking = String(b.thinking || '') + String(delta.delta || ''); }
  else if (type === 'thinking_end') { const b = ensure({ type: 'thinking', thinking: '' }); b.thinking = String(delta.content || b.thinking || ''); }
  else if (type === 'toolcall_start') ensure({ type: 'toolCall', name: 'tool', arguments: {} });
  else if (type === 'toolcall_delta') { const b = ensure({ type: 'toolCall', name: 'tool', arguments: {} }); b._argsRaw = String(b._argsRaw || '') + String(delta.delta || ''); }
  else if (type === 'toolcall_end') { const tc = delta.toolCall; if (tc && typeof tc === 'object') liveBlocks[index] = Object.assign({}, tc); }
  return type === 'done' || type === 'error';
}
// 页面抖动治理：思考/正文 delta 高频重建 + 每 delta 强制滚底会让页面不停跳动。
// 1) renderLive 节流 250ms；2) 仅当用户停留在底部附近（或刚发送消息）才自动滚底，
// 上滑阅读时不再被强行拉回；滚回底部即恢复跟随。
let follow = true, lastLiveRender = 0, liveTimer = null;
function nearBottom() { return document.body.scrollHeight - (window.scrollY || 0) - window.innerHeight < 120; }
window.addEventListener('scroll', () => { follow = nearBottom(); }, { passive: true });
function scrollFollow() { if (follow || nearBottom()) window.scrollTo(0, document.body.scrollHeight); }
function renderLiveThrottled() {
  const now = Date.now();
  if (now - lastLiveRender >= 250) { lastLiveRender = now; renderLive(); return; }
  if (!liveTimer) liveTimer = setTimeout(() => { liveTimer = null; lastLiveRender = Date.now(); renderLive(); }, 250);
}
function renderLive() {
  const old = document.getElementById('live');
  // 每个 delta 都重建 #live，<details> 的展开状态需手动延续（否则流式期间手动展开会被立即拍扁）。
  const wasThinkOpen = old ? !!old.querySelector('.msg.think details')?.open : false;
  if (old) old.remove();
  if (!liveBlocks || !liveBlocks.length) return;
  // 思考折叠：长思考（GLM high 档动辄数千字）不再全文铺开，只留一行状态 + 可展开详情；
  // 正文一旦开始输出，思考自动降为「已思考」，不再与正文抢屏。
  let thinkText = '', hasText = false, html = '';
  for (const b of liveBlocks) {
    if (b.type === 'text' && b.text) { hasText = true; html += bubble('助手', b.text, ''); }
    else if (b.type === 'thinking' && b.thinking) thinkText += String(b.thinking);
    else if (b.type === 'toolCall') html += bubble('工具 · ' + (b.name || 'tool'), previewArgs(b.arguments || b._argsRaw), 'tool');
  }
  if (thinkText) html = thinkBubble(thinkText, !hasText) + html;
  if (!html) return;
  const div = document.createElement('div');
  div.id = 'live'; div.innerHTML = html;
  const wasOpen = old ? !!old.querySelector('details')?.open : false;
  if (wasThinkOpen || wasOpen) { const d = div.querySelector('details'); if (d) d.open = true; }
  document.getElementById('feed').appendChild(div);
  scrollFollow();
}
// ---- 审批卡片 ----
// 主进程程序化应答的保留通道（backend.ts 对这两个 title 提前 return，从不发给桌面端 UI）。
// 它们不是用户交互：placeholder 里装的是内部 JSON 协议。远控页若按普通 input 渲染，用户看到
// 的就是「需要你的确认」+ 空白输入框（2026-10-28 反馈：每个项目进去都弹，点了没反应）。
const INTERNAL_CHANNELS = new Set(['desktop-handoff', 'desktop-automation']);
function renderDialog() {
  const box = document.getElementById('dialogs');
  // 审批卡只在对话视图显示（项目视图一律隐藏，避免悬浮在列表上）；项目卡片上以
  // 「N 待审批」徽标引导用户进入对应会话处理。
  // 取第一个「用户可见」的 dialog：内部协议通道不是交互，跳过它而不是让它占位
  // （否则同会话同时有内部通道与真实审批时，真实审批会被内部通道挡掉）。
  const d = !chatView ? null : [...dialogs.values()].find(x => x.key === current && !INTERNAL_CHANNELS.has(x.request.title || ''));
  if (!d) { box.hidden = true; box.innerHTML = ''; return; }
  const r = d.request;
  const isAsk = r.method === 'input' && r.title === 'desktop-ask';
  let html = '<div class="dialog-card"><div class="dlg-title">' + escapeHtml((r.title === 'desktop-ask' ? '需要你的选择' : r.title) || '需要你的确认') + '</div>';
  html += '<div id="dlg-body"></div></div>';
  box.innerHTML = html;
  box.hidden = false;
  const holder = box.querySelector('#dlg-body');
  if (isAsk) { renderAsk(holder, d); return; }
  if (r.message) { const p = document.createElement('div'); p.className = 'dlg-msg'; p.textContent = r.message; holder.appendChild(p); }
  if (r.method === 'confirm') {
    const row = document.createElement('div'); row.className = 'dlg-row';
    row.appendChild(dlgBtn('拒绝', 'dlg-ghost', () => respondDialog(d, { id: r.id, cancelled: true })));
    row.appendChild(dlgBtn('允许', 'dlg-primary', () => respondDialog(d, { id: r.id, confirmed: true })));
    holder.appendChild(row);
  } else if (r.method === 'select') {
    const wrap = document.createElement('div'); wrap.className = 'dlg-opts';
    (r.options || []).forEach(opt => wrap.appendChild(dlgBtn(opt, 'dlg-opt', () => respondDialog(d, { id: r.id, value: opt }))));
    holder.appendChild(wrap);
    const row = document.createElement('div'); row.className = 'dlg-row';
    row.appendChild(dlgBtn('取消', 'dlg-ghost', () => respondDialog(d, { id: r.id, cancelled: true })));
    holder.appendChild(row);
  } else {
    const isEditor = r.method === 'editor';
    const el = document.createElement(isEditor ? 'textarea' : 'input');
    if (isEditor) el.rows = 3; else el.type = 'text';
    if (r.placeholder) el.placeholder = r.placeholder;
    el.value = r.prefill || '';
    holder.appendChild(el);
    const row = document.createElement('div'); row.className = 'dlg-row';
    row.appendChild(dlgBtn('取消', 'dlg-ghost', () => respondDialog(d, { id: r.id, cancelled: true })));
    row.appendChild(dlgBtn('提交', 'dlg-primary', () => respondDialog(d, { id: r.id, value: el.value })));
    holder.appendChild(row);
    setTimeout(() => el.focus(), 50);
  }
}
function dlgBtn(label, cls, onClick) {
  const b = document.createElement('button');
  b.className = cls; b.type = 'button'; b.textContent = label;
  if (cls === 'dlg-opt') { const parts = label.split(' — '); b.innerHTML = '<b>' + escapeHtml(parts[0]) + '</b>' + (parts[1] ? '<small>' + escapeHtml(parts.slice(1).join(' — ')) + '</small>' : ''); }
  b.addEventListener('click', onClick);
  return b;
}
// desktop-ask 富问题卡片：payload 在 placeholder，回答以 JSON 提交（与桌面 AskQuestionCard 同格式）。
function renderAsk(holder, d) {
  let payload = null;
  try { payload = JSON.parse(d.request.placeholder || ''); } catch { /* 非法载荷按普通 input 处理 */ }
  if (!payload || !Array.isArray(payload.questions) || !payload.questions.length) {
    holder.innerHTML = '';
    const p = document.createElement('div'); p.className = 'dlg-msg'; p.textContent = d.request.message || ''; holder.appendChild(p);
    const row = document.createElement('div'); row.className = 'dlg-row';
    const input = document.createElement('input'); input.type = 'text';
    row.appendChild(dlgBtn('取消', 'dlg-ghost', () => respondDialog(d, { id: d.request.id, cancelled: true })));
    const submit = () => respondDialog(d, { id: d.request.id, value: input.value });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    row.insertBefore(input, row.firstChild);
    row.appendChild(dlgBtn('提交', 'dlg-primary', submit));
    holder.appendChild(row);
    return;
  }
  holder.innerHTML = '';
  const picked = payload.questions.map(() => []);
  const others = payload.questions.map(() => '');
  const rebuild = () => {
    holder.innerHTML = '';
    payload.questions.forEach((q, qi) => {
      const sec = document.createElement('div'); sec.style.marginBottom = '10px';
      const head = document.createElement('div'); head.className = 'dlg-title';
      head.textContent = (q.header ? q.header + ' · ' : '') + q.question + (q.multiSelect ? '（可多选）' : '');
      sec.appendChild(head);
      (q.options || []).forEach(o => {
        const on = picked[qi].indexOf(o.label) >= 0;
        const b = dlgBtn((on ? '✓ ' : '') + o.label + (o.description ? ' — ' + o.description : ''), 'dlg-opt', () => {
          if (q.multiSelect) {
            const at = picked[qi].indexOf(o.label);
            if (at >= 0) picked[qi].splice(at, 1); else picked[qi].push(o.label);
          } else picked[qi] = on ? [] : [o.label];
          rebuild();
        });
        if (on) b.style.borderColor = 'var(--accent)';
        sec.appendChild(b);
      });
      holder.appendChild(sec);
    });
    const row = document.createElement('div'); row.className = 'dlg-row';
    row.appendChild(dlgBtn('取消', 'dlg-ghost', () => respondDialog(d, { id: d.request.id, cancelled: true })));
    const complete = picked.every(labels => labels.length > 0);
    const submitBtn = dlgBtn('提交', 'dlg-primary', () => {
      if (!complete) return;
      const answers = payload.questions.map((q, qi) => ({
        header: q.header || String(q.question || '').slice(0, 12),
        answers: picked[qi].map(l => (l === '__other__' ? (others[qi] || '').trim() : l)),
      }));
      respondDialog(d, { id: d.request.id, value: JSON.stringify(answers) });
    });
    if (!complete) submitBtn.style.opacity = '.5';
    row.appendChild(submitBtn);
    holder.appendChild(row);
  };
  rebuild();
}
function respondDialog(d, response) {
  const id = d.request.id;
  post('/api/respond', { key: d.key, generation: d.generation, response })
    .then(() => { dialogs.delete(id); renderDialog(); })
    .catch(e => {
      // 失败不盲目撤卡（review P2）：网络抖动/响应丢包时桌面端 dialog 仍有效，
      // 撤了就丢一次交互机会。改为向桌面端对账——权威快照已无该 id 才撤（死卡片
      // 循环的根治点）；仍有效则保留卡片，用户重试即可。
      api('/api/state').then(s2 => {
        const live = new Set();
        for (const r of s2.runs || []) for (const dg of r.dialogs || []) live.add(dg.request.id);
        if (!live.has(id)) {
          // 桌面端快照已无此 id：要么他端已处理，要么已过期。两种都不该让用户对着一个
          // 永不可能成功的卡片重复点击——明确告知后消失，而不是留死卡片。
          dialogs.delete(id); renderDialog();
          document.getElementById('conn').textContent = '该确认已在其他端处理或已过期';
          return;
        }
        document.getElementById('conn').textContent = '提交未送达，请重试';
      }).catch(() => { document.getElementById('conn').textContent = String(e.message || e); });
    });
}
function seedDialogs(state) {
  for (const r of state.runs || []) for (const dg of r.dialogs || []) {
    dialogs.set(dg.request.id, { key: r.key, generation: dg.generation, request: dg.request });
  }
  renderDialog();
}

// ---- 数据加载 ----
async function loadState() {
  try {
    const s = await api('/api/state');
    sessions = s.sessions || [];
    runs = new Map((s.runs || []).map(r => [r.key, r]));
    // 权威对账：断线期间漏掉 ui-resolved 的死卡片在此消失（同 id 保留未应答的新卡）。
    const live = new Set();
    for (const r of s.runs || []) for (const dg of r.dialogs || []) live.add(dg.request.id);
    for (const id of [...dialogs.keys()]) if (!live.has(id)) dialogs.delete(id);
    if (chatView) { const d = [...dialogs.values()].find(x => x.key === current); if (!d) renderDialog(); }
    stateLoaded = true;
    seedDialogs(s);
    document.getElementById('projSearch').disabled = false;
    // 同时给出桌面应用版本与 pi 运行时版本，方便远程排查「连的是哪一代桌面」。
    document.getElementById('conn').textContent = '已连接' + (s.desktopVersion ? ' · Desktop ' + s.desktopVersion : '') + ' · pi ' + (s.version || '');
    if (chatView) { // 对话视图：刷当前项目 select 选择器 + 历史
      const sel = document.getElementById('session');
      const cur = current;
      const cwd = (sessions.find(x => x.key === cur) || {}).cwd || null;
      sel.innerHTML = '';
      for (const x of sessions.filter(x2 => !cwd || x2.cwd === cwd)) {
        const o = document.createElement('option');
        o.value = x.key; o.textContent = x.name || x.key;
        if (x.key === cur) o.selected = true;
        sel.appendChild(o);
      }
      statusPill(); renderComposer(); await loadHistory();
    } else {
      projectsPill();
      renderProjects();
    }
  } catch (e) {
    document.getElementById('conn').textContent = String(e.message || e);
    document.getElementById('projStat').textContent = '连接失败';
    // 搜索只读本地 sessions，与本次 /api/state 成败无关：失败也不能把输入框永久锁死
    // （用户 2026-10-28 反馈连接失败后无法输入）。留可用状态，用户至少能搜已加载内容。
    document.getElementById('projSearch').disabled = false;

    document.getElementById('projList').innerHTML = '<div class="empty">无法连接桌面端（二维码可能已失效，请回桌面端重新扫码）</div>';
  }
}
// 重置懒加载状态：会话切换 / 离开会话时调用，游标与已加载窗口一并清空。
function resetHistoryState() { viewPages = new Map(); olderCursor = null; olderLoading = false; }
async function loadHistory() {
  if (!current) { document.getElementById('feed').innerHTML = '<div class="empty">还没有会话</div>'; resetHistoryState(); return; }
  try {
    // 只拉 tail（最近一页）：151MB 大会话不再全量重拉。返回 before = 本页起始索引，
    // 即「加载更早」要用的游标。回合结束 / 切会话 / 回前台都走这里。
    const h = await api('/api/history?session=' + encodeURIComponent(current));
    const page = Array.isArray(h.branch) ? h.branch : [];
    const start = Number(h.before) || 0;
    viewPages = new Map();
    for (let i = 0; i < page.length; i++) viewPages.set(start + i, page[i]);
    olderCursor = h.hasMore ? start : null;
    render(null);
  } catch (e) { document.getElementById('feed').innerHTML = '<div class="empty">无法读取会话</div>'; }
}
// 上滑到顶点「加载更早」：用 before 游标取更早一页，prepend 进视图并补偿滚动位置
// （记录 scrollHeight 差值，让用户视口内容视觉上不动）。防重入。
async function loadOlder() {
  if (!current || olderLoading || olderCursor === null) return;
  olderLoading = true;
  const btn = document.getElementById('loadOlder');
  if (btn) { btn.disabled = true; btn.textContent = '加载中…'; }
  try {
    const h = await api('/api/history?session=' + encodeURIComponent(current) + '&before=' + olderCursor);
    const page = Array.isArray(h.branch) ? h.branch : [];
    const start = Number(h.before) || 0;
    const prevHeight = document.body.scrollHeight;
    const prevScroll = window.scrollY;
    // 按绝对索引去重并入（分支 append-only，同索引同条目）：prepend 更早的一页。
    for (let i = 0; i < page.length; i++) {
      const idx = start + i;
      if (!viewPages.has(idx)) viewPages.set(idx, page[i]);
    }
    olderCursor = h.hasMore ? start : null;
    render(null, { preserve: true });
    // 前置更早消息后，按 scrollHeight 增量补偿滚动位置：视口内容视觉上不动。
    window.scrollTo(0, prevScroll + (document.body.scrollHeight - prevHeight));
  } catch (e) {
    document.getElementById('conn').textContent = '加载更早失败：' + String(e.message || e);
  } finally {
    olderLoading = false;
  }
}

// ---- SSE：run 状态 / 审批 / 流式增量 ----
function listen() {
  const es = new EventSource('/api/events?token=' + TOKEN);
  es.onopen = () => { document.getElementById('conn').textContent = '实时同步中'; if (!chatView) { projectsPill(); loadState(); } };
  es.onerror = () => { es.close(); document.getElementById('conn').textContent = '连接断开，重试中…'; clearTimeout(reconnectTimer); reconnectTimer = setTimeout(listen, 3000); };
  es.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'run') {
      runs.set(msg.run.key, Object.assign({}, runs.get(msg.run.key), lite(msg.run)));
      if (chatView) { statusPill(); renderComposer(); } else { renderProjects(); }
    }
    else if (msg.type === 'sessions-changed') loadState();
    else if (msg.type === 'ui') {
      dialogs.set(msg.request.id, { key: msg.key, generation: msg.generation, request: msg.request });
      if (msg.key === current && chatView) renderDialog();
    }
    else if (msg.type === 'rpc' && (msg.event.type === 'ui-expired' || msg.event.type === 'ui-resolved')) {
      if (dialogs.delete(msg.event.id)) renderDialog();
    }
    else if (msg.type === 'rpc' && msg.key === current && chatView) {
      const t = msg.event && msg.event.type;
      if (t === 'message_update' && msg.event.assistantMessageEvent) {
        const ended = applyDelta(msg.event.assistantMessageEvent);
        renderLiveThrottled();
        if (ended) { liveBlocks = null; renderLive(); debouncedHistory(); }
      } else if (t === 'message_end' || t === 'agent_settled' || t === 'auto_retry_start' || t === 'compaction_start') {
        liveBlocks = null; renderLive(); debouncedHistory();
      } else if (t === 'queue_update') {
        statusPill();
      }
    }
  };
}
function lite(r) { return { key: r.key, status: r.status, cwd: r.cwd, pending: r.pending, error: r.error, generation: r.generation }; }
let histTimer = null;
function debouncedHistory() { clearTimeout(histTimer); histTimer = setTimeout(loadHistory, 400); }

// ---- 发送 / 停止 ----
const ta = document.getElementById('input');
ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 120) + 'px'; });
ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); document.getElementById('composer').requestSubmit(); } });
// ---- 图片附件：选择 → dataURL → raw base64（数量/MIME/总长与 /api/prompt 服务端同口径） ----
const IMG_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MAX_IMGS = 10;
const MAX_IMG_TOTAL = 10 * 1024 * 1024; // base64 总长 ≤10MiB，与服务端一致
let pendingImages = []; // { name, size, mimeType, data }；File 元数据仅本地 chip 展示，不随请求发送
const imgInput = document.getElementById('imgInput');
imgInput.addEventListener('change', () => {
  const files = Array.prototype.slice.call(imgInput.files || []);
  imgInput.value = ''; // 立即重置，允许再次选择同一个文件
  addImages(files);
});
function addImages(files) {
  const msgs = [];
  const candidates = [];
  for (const f of files) {
    if (pendingImages.length + candidates.length >= MAX_IMGS) { msgs.push('一次最多添加 ' + MAX_IMGS + ' 张图片'); break; }
    const mime = String(f.type || '').toLowerCase();
    if (IMG_MIMES.indexOf(mime) < 0) { msgs.push('不支持的图片格式：' + (f.name || '未知文件')); continue; }
    candidates.push(f);
  }
  if (!candidates.length) { renderImgChips(); if (msgs.length) document.getElementById('conn').textContent = msgs.join('；'); return; }
  let remaining = candidates.length, over = false;
  const done = () => { renderImgChips(); if (msgs.length) document.getElementById('conn').textContent = msgs.join('；'); };
  for (const f of candidates) {
    const reader = new FileReader();
    reader.onload = () => {
      remaining--;
      const raw = String(reader.result || '');
      const m = /^data:[^;,]*;base64,/.exec(raw); // 去掉 dataURL 前缀，只留 raw base64
      const data = m ? raw.slice(m[0].length) : '';
      if (!over) {
        const total = pendingImages.reduce((a, im) => a + im.data.length, 0) + data.length;
        if (total > MAX_IMG_TOTAL) { over = true; msgs.push('图片总大小超过 10 MiB，请减少图片'); }
        else pendingImages.push({ name: f.name, size: f.size, mimeType: String(f.type || '').toLowerCase(), data });
      }
      if (!remaining) done();
    };
    reader.onerror = () => { remaining--; msgs.push('图片读取失败：' + (f.name || '')); if (!remaining) done(); };
    reader.readAsDataURL(f);
  }
}
function fmtBytes(n) {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  if (n >= 1024) return Math.round(n / 1024) + ' KB';
  return n + ' B';
}
function renderImgChips() {
  const box = document.getElementById('imgChips');
  if (!pendingImages.length) { box.hidden = true; box.innerHTML = ''; return; }
  const total = pendingImages.reduce((a, im) => a + im.data.length, 0);
  let html = '';
  pendingImages.forEach((im, i) => {
    html += '<span class="chip">&#128247; <span class="chip-name">' + escapeHtml(im.name || '图片') + '</span>'
      + '<span class="chip-size">' + fmtBytes(im.size || 0) + '</span>'
      + '<button type="button" class="chip-x" data-rm="' + i + '" aria-label="移除图片">&#10005;</button></span>';
  });
  html += '<span class="chips-total">' + pendingImages.length + ' 张 · 编码后 ' + fmtBytes(total) + ' / 10 MB</span>';
  box.innerHTML = html;
  box.hidden = false;
}
document.getElementById('imgChips').addEventListener('click', e => {
  const b = e.target.closest('[data-rm]');
  if (!b) return;
  pendingImages.splice(Number(b.getAttribute('data-rm')), 1);
  renderImgChips();
});
// 编辑态：entryId 非空时，下一次提交不是新消息而是 fork 截断重发（对齐桌面语义）。
let editingEntry = null;
// 半提交错误前缀：后端 editResend 在 fork 成功后发送失败时加此标记（Error 属性
// 过不了 HTTP JSON，用消息前缀传递「历史已回退但未发送」的阶段信息）。
const SENDFAIL_PREFIX = 'EDIT_RESEND_SEND_FAILED_AFTER_FORK:';
// 乐观项实例序号：同一文本连发/跨会话同文时，失败撤回按 id 精确命中自己那条。
let optimisticSeq = 0;
/** 按 entryId 从原始条目取完整用户文本：展示层有 8000 字截断且按钮文案混在
 *  textContent 里（「用户编辑…」），从 DOM 反提会污染内容（review P1 实证）。 */
function originalUserText(entryId) {
  for (const e of viewPages.values()) {
    if (e && e.type === 'message' && e.id === entryId && e.message && e.message.role === 'user') return textOf(e.message.content);
  }
  return '';
}
document.getElementById('feed').addEventListener('click', e => {
  const btn = e.target.closest('[data-edit]');
  if (!btn) return;
  const entryId = btn.getAttribute('data-edit');
  editingEntry = entryId;
  ta.value = originalUserText(entryId).trim(); ta.focus();
  document.getElementById('composer').classList.add('editing');
  document.getElementById('conn').textContent = '编辑模式：修改后发送将重发该消息（截断其后对话）';
});
document.getElementById('composer').addEventListener('submit', e => {
  e.preventDefault();
  follow = true; // 发送后恢复自动跟随
  const text = ta.value.trim();
  if (!current) return;
  // 编辑重发路径：forkTo 只接受 idle 态（后端会拒运行中），失败保留输入框内容。
  if (editingEntry) {
    const entryId = editingEntry; editingEntry = null;
    post('/api/edit', { key: current, entryId, text })
      .then(() => { ta.value = ''; ta.style.height = 'auto'; document.getElementById('composer').classList.remove('editing'); document.getElementById('conn').textContent = '已重发'; loadHistory(); })
      .catch(err => {
      const msg = String(err.message || err);
      if (msg.startsWith(SENDFAIL_PREFIX)) {
        // 半提交（fork 已成功、消息未发出）：历史已截断，旧 entry 的重试毫无意义。
        // 退出编辑态、刷新历史（让用户看到截断后的真实状态）、把输入框内容留给
        // 普通发送入口——直接发这条文本即可在当前（截断后）会话里继续。
        editingEntry = null;
        document.getElementById('composer').classList.remove('editing');
        document.getElementById('conn').textContent = '已回退到该消息，但发送失败：' + msg.slice(SENDFAIL_PREFIX.length) + '。输入框内容已保留，直接发送即可继续。';
        loadHistory();
        return;
      }
      // fork 之前被拒（运行中/待审批/斜杠命令等）：未截断，保留编辑态可重试。
      editingEntry = entryId;
      document.getElementById('conn').textContent = '重发失败：' + msg;
    });
    return;
  }
  const imgs = pendingImages.map(im => ({ type: 'image', mimeType: im.mimeType, data: im.data }));
  // 服务端允许纯图请求，但 backend 会拒空文本：与桌面同口径补说明文字。
  const sent = imgs.length && !text ? '请查看所附文件。' : text;
  if (!sent) return;
  const body = { key: current, text: sent };
  if (imgs.length) body.images = imgs;
  editingEntry = null; document.getElementById('composer').classList.remove('editing');
  // 乐观发送先上屏（不等 POST）：backend.prompt 同步等 pi 的 prompt RPC 响应，
  // 慢模型/大附件时 POST 可拖到秒级——输入框与回显必须立刻响应。
  const optId = ++optimisticSeq;
  optimistic.push({ match: sent, display: imgs.length ? ('📷 ' + imgs.length + ' 张' + (text ? '\\n' + text : '')) : text, id: optId });
  ta.value = ''; ta.style.height = 'auto';
  pendingImages = []; renderImgChips();
  render(null);
  document.getElementById('conn').textContent = '发送中…';
  post('/api/prompt', body)
    .then(() => { document.getElementById('conn').textContent = '已发送'; })
    .catch(err => {
      // 失败只撤自己这条（按实例 id）：同文本并发发送时按 match 撤会误伤另一条
      // （review P2：两条同文 pending，一条失败曾把两条都撤掉）。
      optimistic = optimistic.filter(o => o.id !== optId);
      render(null);
      document.getElementById('conn').textContent = '发送失败：' + String(err.message || err);
    });
});
// ---- 回前台刷新：移除/归档的项目无需等 SSE（chat 视图，防抖 500ms） ----
let visTimer = null;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !chatView) return;
  clearTimeout(visTimer);
  visTimer = setTimeout(loadState, 500);
});
document.getElementById('stopbtn').addEventListener('click', () => {
  if (!current) return;
  post('/api/stop', { key: current })
    .then(() => { document.getElementById('conn').textContent = '已请求停止'; })
    .catch(err => { document.getElementById('conn').textContent = '停止失败：' + String(err.message || err); });
});

showProjects();
loadState(); listen();
<\/script>
</body>
</html>`;
}
