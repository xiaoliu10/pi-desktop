import type { RecoveredSubagent } from './subagents';
import { workflowDetails, workflowRows } from '../../shared/subagent-workflow';

/** Reconcile individual clocks: a fresh sibling/inventory must not roll back a
 * newer child observation. Unavailable data is explicitly unknown, not success. */
export function mergeSubagentSnapshots(previous: RecoveredSubagent[], incoming: RecoveredSubagent[]): RecoveredSubagent[] {
  return incoming.map(rec => {
    const next = workflowDetails(rec.details, rec.callId);
    const oldRec = previous.find(p => p.callId === rec.callId);
    const old = oldRec && workflowDetails(oldRec.details, rec.callId);
    if (!next || !old || next.runId !== old.runId) return rec;
    if (next.snapshotAt && old.snapshotAt && next.snapshotAt < old.snapshotAt) return oldRec!;
    const oldRows = workflowRows(old);
    const rows = workflowRows(next).map(row => {
      const prior = oldRows.find(p => p.childId === row.childId && p.runId === row.runId);
      return prior?.snapshotAt && row.snapshotAt && prior.snapshotAt > row.snapshotAt ? prior : row;
    });
    for (const prior of oldRows) if (!rows.some(row => row.childId === prior.childId)) {
      rows.push({ childId: prior.childId, runId: prior.runId, agent: prior.agent, state: 'unknown' });
    }
    return { ...rec, details: { ...next, steps: undefined, workflowChildren: { version: 1, parentToolCallId: rec.callId, workflowRunId: next.runId, ...next.workflowChildren, children: rows } } };
  });
}

/** One request at a time per mounted selected-session view. Cancellation invalidates
 * late responses even A -> B -> A, and never leaves an interval running on unmount. */
export function pollSubagents(options: {
  key: string;
  /** 分支尖端在每次 tick 现取：leaf 随每条消息推进，若把发起时的 leaf 当作响应有效性条件，
   *  活跃会话里几乎每次轮询都会被丢弃（子代理卡片因此迟迟不出现）。分支正确性由
   *  主进程按当次 leaf 读历史保证，跨会话保护由 isCurrent（只比 sessionKey）承担。 */
  leaf?: () => string | undefined;
  recover: (key: string, leaf?: string) => Promise<RecoveredSubagent[]>;
  isCurrent: () => boolean;
  publish: (records: RecoveredSubagent[]) => void;
  interval?: number;
}): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    const leaf = options.leaf?.();
    try {
      const records = await options.recover(options.key, leaf);
      // Branch consistency: a response carries data for the branch selected at
      // request time. If the user switched branches meanwhile (leaf changed),
      // drop it — the next tick reads the current branch. Only meaningful when
      // a branch was explicitly selected (undefined = trunk, always current).
      if (stopped || !options.isCurrent() || (leaf && options.leaf && options.leaf() !== leaf) || !Array.isArray(records)) return;
      options.publish(records);
    } catch { /* IPC transport failure is not a completion observation. Retry. */ }
    finally {
      if (!stopped && options.isCurrent()) timer = setTimeout(() => { void tick(); }, options.interval ?? 2000);
    }
  };
  void tick();
  return () => { stopped = true; clearTimeout(timer); };
}
