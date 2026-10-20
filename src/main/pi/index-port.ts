import type { PiEntry, PiHistory, PiOutline, PiSearchResult, PiSession } from '../../shared/pi';
import type { SubagentSnapshot } from './subagent-snapshots';
import type { UsageStats } from './usage-stats';

/** Transport-neutral surface the Desktop main process depends on for session data.
 *
 *  Why this exists: every filesystem walk, readFileSync and JSON.parse used to run on
 *  the Electron main thread (cold scan 6.5s, periodic full scan ~450ms, single large
 *  reparse 550ms+). A blocked main thread is what turns into a spinning/loading cursor.
 *  `IndexWorkerClient` keeps the real index in a utility process and exposes only
 *  cheap, already-materialised reads here; `SessionIndex` implements the same surface
 *  in-process so backend/sidecar tests and non-Electron callers keep working.
 *
 *  Three groups:
 *   - Mirror reads (synchronous, never touch the filesystem): session metadata list and
 *     a bounded recent-branch window that the owner keeps pushed. Callers must treat a
 *     miss as "unavailable" (the pre-existing fail-closed path), never as empty data.
 *   - Owner RPC (asynchronous, may parse): history projection for the renderer, search,
 *     outline, subagent history, remote pagination.
 *   - Lifecycle: start/ready/close plus subscription for the mirrored branch window.
 */
export interface IndexPort {
  /** Session metadata list. Synchronous and filesystem-free under the worker client. */
  scan(includeSidecars?: boolean): PiSession[];
  /** Same metadata list without re-sorting expectations; kept for the sidebar IPC path. */
  sessionsView(includeSidecars?: boolean): PiSession[];
  /** Metadata for one key, or undefined when the owner has never seen it. */
  sessionMeta(key: string): PiSession | undefined;
  /** Last `n` entries of the cached branch tip. Throws `IndexUnavailableError` when the
   *  key is not mirrored locally — it never returns a silently truncated result. */
  branchTail(key: string, n: number): PiEntry[];
  /** 事件时刻的分支窗口（异步 owner 读）：worker 内走 `history()` 的增量解析，读到刚
   *  落盘的真值。同步镜像读只由 owner 的 `changed` 推送刷新（最坏滞后 = watch 120ms
   *  debounce + IPC），而 pi 的 RPC 事件（compaction_end / agent_settled）在写完文件后
   *  立刻经另一条通道到达——事件时刻镜像大概率落后至少一条，消费方必须用这个异步读，
   *  不能读镜像。失败抛错走调用方既有 fail-closed 分支。 */
  branchTailAsync(key: string, n: number): Promise<PiEntry[]>;
  /** 用量统计：在 owner 内按需读取/聚合会话文件，只回聚合结果（几百字节）。主进程
   *  不做任何会话文件 IO（旧实现在主线程 readFileSync 所有会话，1.1GB 数据集 ≈ 3-4s
   *  主线程独占）。 */
  usageStatsAsync(now?: Date): Promise<UsageStats>;

  /** Renderer-facing history. `tail`/`before`/`count` keep the payload bounded and the
   *  reply already carries the Desktop transport projection. */
  historyAsync(key: string, leaf?: string, opts?: { tail?: number; before?: string; count?: number }): Promise<PiHistory>;
  /** Mobile viewer page: `before` cursor semantics match `historyWindow` in remote-server. */
  remotePage(key: string, before: string | null, page: number): Promise<{ branch: PiEntry[]; hasMore: boolean; before: number } | null>;
  searchAsync(key: string, query: string, opts?: { limit?: number }): Promise<PiSearchResult>;
  outlineAsync(key: string): Promise<PiOutline>;
  /** Subagent recovery needs the full branch plus the on-disk subagent directories, so
   *  it runs in the owner and only bounded display snapshots come back. */
  recoverSubagents(agentDir: string, key: string, leaf?: string, pinned?: string[], knownSignature?: string): Promise<SubagentSnapshot[] | { unchanged: true }>;
  subagentChildTranscript(agentDir: string, key: string, callId: string, childId: string): Promise<{ messages: Record<string, unknown>[]; truncated: boolean } | { error: string }>;
  /** 在 worker 内把外部 CLI 会话的无损全量条目复制成 Desktop 副本（fork-to-continue）。
   *  全量 entries 绝不跨进程回主进程（最大实测 200MB 级）：worker 直接用缓存里的
   *  无损条目按既有逐行 JSON 规则写盘，只回条目数。原子写（tmp+rename），失败不留半文件。 */
  forkCopySource(key: string, targetPath: string, header: ForkCopyHeader): Promise<{ path: string; entries: number }>;

  /** Begin watching for changes. Resolves once the first metadata snapshot is available. */
  start(changed: () => void): Promise<void>;
  /** Resolves when mirror reads are trustworthy. */
  ready(): Promise<void>;
  /** Keep the mirrored metadata/branch window fresh for this key. Idempotent, refcounted. */
  subscribe(key: string): Promise<void>;
  unsubscribe(key: string): void;
  close(): void;
}

/** Thrown when a synchronous mirror read cannot be satisfied. Mirrors the historical
 *  "session unavailable" failure mode so callers keep their existing fail-closed paths. */
export class IndexUnavailableError extends Error {
  constructor(readonly key?: string) { super('Session unavailable'); this.name = 'IndexUnavailableError'; }
}

/** fork-copy 时新会话头的覆盖字段（新 id / 时间戳 / parentSession）。 */
export interface ForkCopyHeader { id: string; timestamp: string; parentSession: string }
