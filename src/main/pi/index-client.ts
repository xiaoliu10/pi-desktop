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

/** Longest a single owner request may wait. Cold scan of the real dataset (367 sessions
 *  / 1.1GB) measured 6.7s; 60s ≈ 9× margin. Anything past this means the owner is wedged
 *  — fail the request AND restart the owner once, instead of leaving the UI spinning for
 *  the rest of the window (旧值 120s：重启窗口内的请求全部静默挂满两分钟). */
export const REQUEST_TIMEOUT_MS = 60_000;

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
  /** P0-1：ready 用 waiter 列表，不用单个可被替换的 promise。旧实现 scheduleRestart
   *  直接替换 readyPromise，最早的 awaiter（app 启动路径的 await host.ready()）永久挂
   *  起——worker 崩溃变成「应用只有 dock 图标、永不建窗」的静默死。 */
  private isReady = false;
  private readyWaiters: Array<() => void> = [];
  private booted = false;
  /** 重启窗口内（exit → 新 worker ready）：请求必须立即 fail-closed，不能发进死
   *  transport（post 是静默丢弃，请求只能等 120s 超时）。 */
  private restarting = false;
  /** P1-4：首个快照（含每次重启后新 worker 的首个快照）必须唤醒 changed——渲染层
   *  在镜像为空时拉过列表后，只能靠这条通知重拉。 */
  private seenSnapshot = false;
  private fatal: Error | undefined;
  private closing = false;
  private restartAttempts = 0;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly config: WorkerConfig, private readonly spawn: (config: WorkerConfig) => IndexTransport) {}

  /** Boot the owner process once; repeated callers join readiness waiters. */
  start(changed: () => void): Promise<void> {
    this.changed = changed;
    return this.ready();
  }

  ready(): Promise<void> {
    // 任何时刻 await 的调用方都保证被唤醒：waiter 挂在列表上，onWorkerReady/fatal/
    // close 时 flush；重启期间 isReady=false，重新排队等下一次就绪。
    if (this.isReady) return Promise.resolve();
    const promise = new Promise<void>(resolve => { this.readyWaiters.push(resolve); });
    // 只有「从未启动」且没有排程中的重启才在这里拉起；重启窗口内由退避定时器拉起，
    // 不能绕过退避立即 spawn。
    if (!this.booted && this.restartTimer === undefined) this.boot();
    return promise;
  }

  /** 创建并接线一个 transport（首次启动与崩溃重启共用）。spawn 同步抛错按一次
   *  失败尝试处理（计入退避重启），不直接置 fatal——偶发的拉起失败值得重试。 */
  private boot(): void {
    if (this.fatal || this.closing) return;
    this.booted = true;
    this.restartTimer = undefined;
    try {
      const transport = this.spawn(this.config);
      this.transport = transport;
      transport.onMessage(raw => { if (this.transport === transport) this.onMessage(raw as WorkerEvent | WorkerReply); });
      // 只响应现役 transport 的退出：超时判死/主动失效（transport 已置 undefined）或
      // 已被新 worker 更替后，旧 transport 的迟到退出不得清掉新镜像/重复计数。
      transport.onExit((code, reason) => { if (this.transport === transport) this.onExit(code, reason); });
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
    const total = this.total.get(key) ?? tail.length;
    // 窗口被字节预算裁剪过（total > 镜像条数）时，比窗口更大的 n 不可能满足：
    // fail closed，绝不静默返回少于 n 条（消费方走既有 catch/上抛 fail-closed 路径）。
    // total == tail.length 时分支本来就只有这么长，返回全部是准确数据。
    if (n > tail.length && total > tail.length) throw new IndexUnavailableError(key);
    return n >= tail.length ? [...tail] : tail.slice(tail.length - n);
  }

  /** 事件时刻的 owner 读（P0-2）：镜像由 changed 推送刷新（最坏滞后 120ms debounce +
   *  IPC），而 pi 的 RPC 事件在写完文件后立刻到达——事件时刻镜像大概率落后至少一条。
   *  压缩留痕/重试条目这类「写完马上读」的消费方必须走这里，不能读镜像。 */
  branchTailAsync(key: string, n: number): Promise<PiEntry[]> {
    return this.request({ op: 'branchTail', key, n }) as Promise<PiEntry[]>;
  }

  /** 用量统计：聚合在 worker 内按需完成，主进程只收聚合结果（P1-6）。 */
  usageStatsAsync(now?: Date): Promise<import('./usage-stats').UsageStats> {
    return this.request({ op: 'usageStats', ...(now === undefined ? {} : { now: Number(now) }) }) as Promise<import('./usage-stats').UsageStats>;
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
    try {
      await this.ready();
      await this.request({ op: 'subscribe', key });
    } catch (error) {
      // 失败回滚引用计数（P2-6）：不回滚的话幽灵订阅卡在 1，后续 unsubscribe 永远
      // 通知不到 worker（sidecar finally 里的 unsubscribe 只覆盖 subscribe 成功之后）。
      const current = this.subscriptions.get(key) ?? 0;
      if (current <= 1) {
        this.subscriptions.delete(key);
        this.tails.delete(key);
        this.total.delete(key);
      } else {
        this.subscriptions.set(key, current - 1);
      }
      throw error;
    }
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
    this.markReady(); // close 后 await ready() 的调用方不得永久挂起（waiter flush）
  }

  private request(payload: WorkerRequestPayload): Promise<unknown> {
    if (this.fatal) return Promise.reject(this.fatal);
    // P1-1：死 transport 的 post 是静默丢弃（进程不在了 postMessage 无效果），重启
    // 窗口内的请求必须在这里立即 fail-closed，而不是进黑洞等 120s 超时。
    if (!this.transport || this.restarting) return Promise.reject(new IndexUnavailableError());
    const id = ++this.seq;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`会话索引响应超时（${payload.op}）`));
        // 超时 = owner 大概率卡死：只 reject 的话卡死的进程永远不会自愈，下个请求再
        // 挂满整个窗口。判死 → transport 失效 → 走既有有界退避重启（200ms/1s/3s/上限）。
        const wedged = this.transport;
        this.transport = undefined;
        this.tails.clear();
        this.total.clear();
        this.seenSnapshot = false;
        try { wedged?.terminate(); } catch { /* already gone */ }
        this.failAll(new Error(`会话索引响应超时（${payload.op}）`));
        this.scheduleRestart(new Error(`会话索引进程 ${REQUEST_TIMEOUT_MS / 1000}s 未响应 ${payload.op}，判定卡死`), `请求超时：${payload.op}`);
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
      case 'sessions':
        this.sessions = event.sessions;
        // P1-4：首个快照（含重启后新 worker 的首个快照）必须唤醒 changed。渲染层在
        // configure()/启动后镜像为空时拉过一次列表，没有这条通知就只剩 watch 的巧合
        // 拍兜底（顺序性假变化，1.8s 后才有）。常规拍不重复触发：worker 每拍快照后
        // 总跟一条 changed 事件，重复触发会让流式期间每 120ms 双倍 reload。
        if (!this.seenSnapshot) {
          this.seenSnapshot = true;
          this.changed?.();
        }
        break;
      case 'tail':
        if (event.unavailable) {
          this.tails.delete(event.key);
          this.total.delete(event.key);
        } else {
          this.tails.set(event.key, event.tail);
          this.total.set(event.key, event.total);
        }
        break;
      case 'changed': this.changed?.(); break;
      case 'ready':
        this.onWorkerReady();
        break;
      case 'fatal':
        // worker 配置无效等自检失败：重启也是同样结果，直接置 fatal，不重试。
        clearTimeout(this.restartTimer);
        this.restartTimer = undefined;
        this.fatal = new Error(event.message);
        this.failAll(this.fatal);
        const failed = this.transport;
        this.transport = undefined;
        try { failed?.terminate(); } catch { /* already gone */ }
        this.tails.clear();
        this.total.clear();
        this.restarting = false;
        console.error(`[index-worker] fatal: ${event.message}`);
        this.logRestart(`fatal: ${event.message}`);
        this.markReady();
        break;
    }
  }

  private onExit(code: number | null, reason?: string): void {
    if (this.closing) { this.markReady(); return; }
    if (this.fatal) return;
    // 意外退出：先拒绝所有挂起请求，并清空分支尾窗镜像——重启完成前任何 branchTail
    // 必须抛 IndexUnavailableError 走 fail-closed，绝不返回冻结的旧分支。元数据列表
    // 保留到新 worker 的首个快照原子替换（避免侧栏闪空），随后的 ready 前不做写操作。
    const detail = `code=${code ?? '?'}${reason ? `, ${reason}` : ''}`;
    // P1-1：死 transport 立即失效（boot 成功时才重新赋值）——spawn 同步抛错时旧引用
    // 还在，请求会全部发进静默丢弃的黑洞。
    this.transport = undefined;
    this.restarting = true;
    this.isReady = false;
    this.seenSnapshot = false; // 新 worker 首个快照再次唤醒 changed（镜像重新填充）
    this.failAll(new Error(`会话索引进程意外退出（${detail}）`));
    this.tails.clear();
    this.total.clear();
    this.scheduleRestart(new Error(`会话索引进程意外退出（${detail}）`), detail);
  }

  /** 有界退避重启。重启窗口期内 ready() 的调用方重新排队（isReady=false），下一次
   *  ready 事件（含重新订阅完成）后才 flush；超过上限才置 fatal。 */
  private scheduleRestart(cause: Error, detail: string): void {
    if (this.closing || this.fatal) return;
    if (this.restartTimer !== undefined) return; // 已有排程中的重启：不重复计数
    const attempt = ++this.restartAttempts;
    this.restarting = true;
    this.isReady = false;
    if (attempt > MAX_RESTARTS) {
      this.fatal = new Error(`会话索引进程连续 ${MAX_RESTARTS} 次重启失败，已停止重试：${cause.message}`);
      this.failAll(this.fatal);
      this.restarting = false;
      this.markReady(); // fatal 也是终态：所有 waiter 必须被唤醒，不能永久挂起
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
    this.restarting = false;
    this.restartAttempts = 0;
    const transport = this.transport;
    const keys = [...this.subscriptions.keys()];
    if (!keys.length) { this.markReady(); return; }
    void Promise.all(keys.map(key => this.request({ op: 'subscribe', key })))
      .then(() => {
        if (this.transport === transport && !this.restarting) this.markReady();
      }, () => {
        // exit/timeout 已使 transport 失效时，waiter 继续等下一代；不能让旧一代
        // 被拒绝的 resubscribe 在微任务里把新一代误标 ready。
        if (this.transport === transport && !this.restarting) this.markReady();
      });
  }

  /** flush 全部 ready waiter 并置 isReady（就绪/fatal/close 三个终态共用）。 */
  private markReady(): void {
    this.isReady = true;
    const waiters = this.readyWaiters.splice(0);
    for (const waiter of waiters) waiter();
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
