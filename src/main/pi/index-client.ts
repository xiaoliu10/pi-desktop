import type { PiEntry, PiHistory, PiOutline, PiSearchResult, PiSession } from '../../shared/pi';
import type { SubagentSnapshot } from './subagent-snapshots';
import { IndexUnavailableError, type IndexPort } from './index-port';
import type { WorkerConfig, WorkerEvent, WorkerReply, WorkerRequest, WorkerRequestPayload } from './index-worker-protocol';
import type { IndexTransport } from './index-transport';
interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** Longest a single owner request may wait. A cold scan of a large history tree is
 *  seconds; anything past this means the owner is wedged, so fail the request rather
 *  than leave the UI awaiting forever. */
const REQUEST_TIMEOUT_MS = 120_000;

/** 意外退出后的有界重启：200ms / 1s / 3s，最多 3 次。超过即置 fatal（不再静默
 *  重试风暴），并在控制台与 main-perf.log 留明确错误。主动 close() 永不重启。 */
const RESTART_DELAYS_MS = [200, 1_000, 3_000] as const;
const MAX_RESTARTS = RESTART_DELAYS_MS.length;

/** Main-process side of the session index.
 *
 *  The owner process holds the real cache, watcher and parser. This class keeps only
 *  bounded mirrors so the main thread never touches the filesystem on a hot path:
 *   - session metadata list (a few hundred small objects),
 *   - per-subscribed-key recent branch window (byte-capped by the owner).
 *
 *  Synchronous reads therefore either return mirrored data or throw
 *  `IndexUnavailableError`, which maps onto the fail-closed paths that already existed
 *  for unreadable sessions. Nothing returns silently-stale or truncated data.
 */
export class IndexWorkerClient implements IndexPort {
  private transport: IndexTransport | undefined;
  private sessions: PiSession[] = [];
  private tails = new Map<string, PiEntry[]>();
  private total = new Map<string, number>();
  private subscriptions = new Map<string, number>();
  private pending = new Map<number, Pending>();
  private seq = 0;
  private changed: (() => void) | undefined;
  private readyResolve: (() => void) | undefined;
  private readyPromise: Promise<void> | undefined;
  private fatal: Error | undefined;
  private closing = false;
  private restartAttempts = 0;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly config: WorkerConfig, private readonly spawn: (config: WorkerConfig) => IndexTransport) {}

  /** Boot the owner process. Safe to call once; repeated calls return the same promise. */
  start(changed: () => void): Promise<void> {
    this.changed = changed;
    return this.ready();
  }

  ready(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise<void>(resolve => { this.readyResolve = resolve; });
    this.boot();
    return this.readyPromise;
  }

  /** 创建并接线一个 transport（首次启动与崩溃重启共用）。spawn 同步抛错按一次
   *  失败尝试处理（计入退避重启），不直接置 fatal——偶发的拉起失败值得重试。 */
  private boot(): void {
    if (this.fatal || this.closing) return;
    try {
      this.transport = this.spawn(this.config);
      this.transport.onMessage(raw => this.onMessage(raw as WorkerEvent | WorkerReply));
      this.transport.onExit((code, reason) => this.onExit(code, reason));
    } catch (error) {
      this.scheduleRestart(error instanceof Error ? error : new Error(String(error)), `spawn 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  scan(includeSidecars = false): PiSession[] {
    return includeSidecars ? this.sessions : this.sessions.filter(s => s.sidecarOf === undefined);
  }

  sessionsView(includeSidecars = false): PiSession[] {
    return this.scan(includeSidecars);
  }

  sessionMeta(key: string): PiSession | undefined {
    return this.sessions.find(s => s.key === key);
  }

  branchTail(key: string, n: number): PiEntry[] {
    const tail = this.tails.get(key);
    if (!tail) throw new IndexUnavailableError(key);
    return n >= tail.length ? [...tail] : tail.slice(tail.length - n);
  }

  /** Total entries on the cached branch (mirrored alongside the tail window). */
  branchLength(key: string): number {
    const total = this.total.get(key);
    if (total === undefined) throw new IndexUnavailableError(key);
    return total;
  }

  async subscribe(key: string): Promise<void> {
    const count = this.subscriptions.get(key) ?? 0;
    this.subscriptions.set(key, count + 1);
    if (count > 0) return;
    // Worker 先推 tail 事件再回 subscribe 应答（同通道消息保序），所以应答 resolve 时
    // branchTail 已可读；会话文件尚不存在（新会话懒创建）时没有 tail 事件，这里也不
    // 等——镜像读按 IndexUnavailableError 走 fail-closed，文件落地后 worker 的 changed
    // 推送会自动填充。
    await this.ready();
    await this.request({ op: 'subscribe', key });
  }

  unsubscribe(key: string): void {
    const count = this.subscriptions.get(key) ?? 0;
    if (count <= 1) {
      this.subscriptions.delete(key);
      this.tails.delete(key);
      this.total.delete(key);
      if (count === 1 && !this.fatal) void this.request({ op: 'unsubscribe', key }).catch(() => undefined);
    } else {
      this.subscriptions.set(key, count - 1);
    }
  }

  historyAsync(key: string, leaf?: string, opts?: { tail?: number; before?: string; count?: number }): Promise<PiHistory> {
    return this.request({ op: 'history', key, ...(leaf === undefined ? {} : { leaf }), ...(opts?.tail === undefined ? {} : { tail: opts.tail }), ...(opts?.before === undefined ? {} : { before: opts.before }), ...(opts?.count === undefined ? {} : { count: opts.count }) }) as Promise<PiHistory>;
  }

  async remotePage(key: string, before: string | null, page: number): Promise<{ branch: PiEntry[]; hasMore: boolean; before: number } | null> {
    return this.request({ op: 'remotePage', key, before, page }) as Promise<{ branch: PiEntry[]; hasMore: boolean; before: number } | null>;
  }

  searchAsync(key: string, query: string, opts?: { limit?: number }): Promise<PiSearchResult> {
    return this.request({ op: 'search', key, query, ...(opts?.limit === undefined ? {} : { limit: opts.limit }) }) as Promise<PiSearchResult>;
  }

  async outlineAsync(key: string): Promise<PiOutline> {
    return this.request({ op: 'outline', key }) as Promise<PiOutline>;
  }

  /** The owner resolves subagent pointers from its own full branch; only bounded display
   *  snapshots cross back, so a 200MB branch is never cloned into the main process. */
  recoverSubagents(_agentDir: string, key: string, leaf?: string, pinned?: string[], knownSignature?: string): Promise<SubagentSnapshot[] | { unchanged: true }> {
    return this.request({ op: 'recoverSubagents', key, ...(leaf === undefined ? {} : { leaf }), ...(pinned === undefined ? {} : { pinned }), ...(knownSignature === undefined ? {} : { knownSignature }) }) as Promise<SubagentSnapshot[] | { unchanged: true }>;
  }

  subagentChildTranscript(_agentDir: string, key: string, callId: string, childId: string): Promise<{ messages: Record<string, unknown>[]; truncated: boolean } | { error: string }> {
    return this.request({ op: 'subagentChildTranscript', key, callId, childId }) as Promise<{ messages: Record<string, unknown>[]; truncated: boolean } | { error: string }>;
  }

  forkCopySource(_key: string, targetPath: string, header: { id: string; timestamp: string; parentSession: string }): Promise<{ path: string; entries: number }> {
    // key 由 protocol 传输；参数顺序跟随 IndexPort（agentDir 不出现在此签名上）。
    return this.request({ op: 'forkCopySource', key: _key, targetPath, header }) as Promise<{ path: string; entries: number }>;
  }

  close(): void {
    this.closing = true;
    clearTimeout(this.restartTimer);
    this.subscriptions.clear();
    this.tails.clear();
    this.total.clear();
    // 有序关闭：让 worker 处理 shutdown（dispose 内 OutlineCache.flushNow 同步落盘）后
    // 自行退出，不立即 kill——否则最后一拍大纲缓存会随进程被杀丢失。卡死时 3s 兑底 kill。
    this.closing = true;
    const transport = this.transport;
    if (transport && !this.fatal) {
      try { transport.post({ id: ++this.seq, op: 'shutdown' } satisfies WorkerRequest); } catch { /* owner already gone */ }
      const killTimer = setTimeout(() => { try { transport.terminate(); } catch { /* gone */ } }, 3_000);
      killTimer.unref?.();
      transport.onExit(() => { clearTimeout(killTimer); try { transport.terminate(); } catch { /* already exited */ } });
    } else {
      try { transport?.terminate(); } catch { /* gone */ }
    }
    this.failAll(new Error('索引已关闭'));
    this.transport = undefined;
  }

  private request(payload: WorkerRequestPayload): Promise<unknown> {
    if (this.fatal) return Promise.reject(this.fatal);
    if (!this.transport) return Promise.reject(new IndexUnavailableError());
    const id = ++this.seq;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`会话索引响应超时（${payload.op}）`));
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try { this.transport!.post({ id, ...payload } as WorkerRequest); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error as Error); }
    });
  }

  private onMessage(message: WorkerEvent | WorkerReply): void {
    if (message && typeof message === 'object' && 'id' in message) {
      const reply = message as WorkerReply;
      const pending = this.pending.get(reply.id);
      if (!pending) return;
      this.pending.delete(reply.id);
      clearTimeout(pending.timer);
      if (reply.ok) pending.resolve(reply.value);
      else {
        const error = new Error(reply.error.message) as Error & { code?: string };
        if (reply.error.code) error.code = reply.error.code;
        pending.reject(error);
      }
      return;
    }
    const event = message as WorkerEvent;
    switch (event.ev) {
      case 'sessions': this.sessions = event.sessions; break;
      case 'tail':
        this.tails.set(event.key, event.tail);
        this.total.set(event.key, event.total);
        break;
      case 'changed': this.changed?.(); break;
      case 'ready':
        this.onWorkerReady();
        break;
      case 'fatal':
        // worker 配置无效等自检失败：重启也是同样结果，直接置 fatal，不重试。
        clearTimeout(this.restartTimer);
        this.fatal = new Error(event.message);
        this.failAll(this.fatal);
        this.readyResolve?.();
        break;
    }
  }

  private onExit(code: number | null, reason?: string): void {
    if (this.closing) { this.readyResolve?.(); return; }
    if (this.fatal) return;
    // 意外退出：先拒绝所有挂起请求，并清空分支尾窗镜像——重启完成前任何 branchTail
    // 必须抛 IndexUnavailableError 走 fail-closed，绝不返回冻结的旧分支。元数据列表
    // 保留到新 worker 的首个快照原子替换（避免侧栏闪空），随后的 ready 前不做写操作。
    const detail = `code=${code ?? '?'}${reason ? `, ${reason}` : ''}`;
    this.failAll(new Error(`会话索引进程意外退出（${detail}）`));
    this.tails.clear();
    this.total.clear();
    this.scheduleRestart(new Error(`会话索引进程意外退出（${detail}）`), detail);
  }

  /** 有界退避重启。重启窗口期内 ready() 返回新的、未决的 promise；下一次 ready 事件
   *  （含重新订阅完成）后才 resolve。超过上限才置 fatal。 */
  private scheduleRestart(cause: Error, detail: string): void {
    if (this.closing || this.fatal) return;
    const attempt = ++this.restartAttempts;
    // 让崩溃后的 ready() 调用等待下一次就绪，而不是拿到早已 resolve 的旧 promise。
    this.readyPromise = new Promise<void>(resolve => { this.readyResolve = resolve; });
    if (attempt > MAX_RESTARTS) {
      this.fatal = new Error(`会话索引进程连续 ${MAX_RESTARTS} 次重启失败，已停止重试：${cause.message}`);
      this.failAll(this.fatal);
      this.readyResolve?.();
      this.logRestart(`fatal：${detail}，放弃重启`);
      console.error(this.fatal.message);
      return;
    }
    const delay = RESTART_DELAYS_MS[attempt - 1] ?? RESTART_DELAYS_MS[RESTART_DELAYS_MS.length - 1];
    console.warn(`[index-worker] 会话索引进程退出（${detail}），${delay}ms 后第 ${attempt}/${MAX_RESTARTS} 次重启`);
    this.logRestart(`意外退出（${detail}），${delay}ms 后第 ${attempt}/${MAX_RESTARTS} 次重启`);
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => this.boot(), delay);
    this.restartTimer.unref?.();
  }

  /** 新 worker 首个快照就绪：重置计数并恢复所有仍被订阅 key 的尾窗，全部到位后
   *  才放开 ready()——保证 await ready() 返回后 branchTail 立即可读。 */
  private onWorkerReady(): void {
    this.restartAttempts = 0;
    const keys = [...this.subscriptions.keys()];
    if (!keys.length) { this.readyResolve?.(); return; }
    Promise.all(keys.map(key => this.request({ op: 'subscribe', key }).catch(() => undefined)))
      .then(() => this.readyResolve?.())
      .catch(() => this.readyResolve?.());
  }

  private logRestart(line: string): void {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { appendFileSync } = require('node:fs') as typeof import('node:fs');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { join } = require('node:path') as typeof import('node:path');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { homedir } = require('node:os') as typeof import('node:os');
      appendFileSync(join(homedir(), 'Library', 'Logs', 'PI Desktop', 'main-perf.log'), `${new Date().toISOString()} index-worker ${line}\n`);
    } catch { /* 观测不可用不影响重启 */ }
  }

  private failAll(error: Error): void {
    for (const [, pending] of this.pending) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
}
