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
  key: string; leaf?: string;
  recover: (key: string, leaf?: string) => Promise<RecoveredSubagent[]>;
  isCurrent: () => boolean;
  publish: (records: RecoveredSubagent[]) => void;
  interval?: number;
}): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    try {
      const records = await options.recover(options.key, options.leaf);
      if (!stopped && options.isCurrent() && Array.isArray(records)) options.publish(records);
    } catch { /* IPC transport failure is not a completion observation. Retry. */ }
    finally {
      if (!stopped && options.isCurrent()) timer = setTimeout(() => { void tick(); }, options.interval ?? 2000);
    }
  };
  void tick();
  return () => { stopped = true; clearTimeout(timer); };
}
