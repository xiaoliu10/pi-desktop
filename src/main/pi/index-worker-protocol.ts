import type { PiEntry, PiHistory, PiOutline, PiSearchResult, PiSession } from '../../shared/pi';
import type { SubagentSnapshot } from './subagent-snapshots';
import type { UsageStats } from './usage-stats';

/** Wire protocol between the Electron main process and the session-data utility process.
 *
 *  Requests carry a monotonically increasing `id`; replies echo it. Events are pushed
 *  without an id. Every value crossing this boundary is structured-cloned, so replies
 *  must stay bounded: history replies are already tail-capped and transport-projected,
 *  and the mirrored branch window is byte-capped (`TAIL_BYTES`).
 */
export interface WorkerConfig {
  roots: string[];
  ownedRoot: string;
  agentDir: string;
  outlineCachePath: string;
  /** 会话列表元数据快照路径（启动秒出列表，见 SessionMetaCache）。 */
  metaCachePath: string;
}

export type WorkerRequest =
  | { id: number; op: 'history'; key: string; leaf?: string; tail?: number; before?: string; count?: number }
  | { id: number; op: 'branchTail'; key: string; n: number }
  | { id: number; op: 'usageStats'; now?: number }
  | { id: number; op: 'remotePage'; key: string; before: string | null; page: number }
  | { id: number; op: 'search'; key: string; query: string; limit?: number }
  | { id: number; op: 'outline'; key: string }
  | { id: number; op: 'recoverSubagents'; key: string; leaf?: string; pinned?: string[]; knownSignature?: string }
  | { id: number; op: 'subagentChildTranscript'; key: string; callId: string; childId: string }
  | { id: number; op: 'forkCopySource'; key: string; targetPath: string; header: { id: string; timestamp: string; parentSession: string } }
  | { id: number; op: 'subscribe'; key: string }
  | { id: number; op: 'unsubscribe'; key: string }
  | { id: number; op: 'shutdown' };

// Omit 在联合上不分发（会收敛成公共键），用条件类型逐成员分发。
type DistributiveOmit<T, K extends keyof never | string> = T extends unknown ? Omit<T, K> : never;
export type WorkerRequestPayload = DistributiveOmit<WorkerRequest, 'id'>;

export type WorkerReply =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: { message: string; code?: string } };

export type WorkerEvent =
  /** Full metadata snapshot (sidecars included; the client filters). Already sorted. */
  | { ev: 'sessions'; sessions: PiSession[] }
  /** Bounded recent-branch window for a subscribed key. */
  | { ev: 'tail'; key: string; tail: PiEntry[]; total: number; unavailable?: true }
  /** Metadata snapshot applied; wake the `start()` change callback. */
  | { ev: 'changed' }
  /** First scan finished; mirror reads are trustworthy from here on. */
  | { ev: 'ready' }
  | { ev: 'fatal'; message: string };

export type ReplyValue =
  | PiHistory
  | PiOutline
  | PiSearchResult
  | SubagentSnapshot[]
  | PiEntry[]
  | UsageStats
  | { unchanged: true }
  | { messages: Record<string, unknown>[]; truncated: boolean }
  | { error: string }
  | { branch: PiEntry[]; hasMore: boolean; before: number }
  | { path: string; entries: number }
  | null
  | undefined
  | true;
