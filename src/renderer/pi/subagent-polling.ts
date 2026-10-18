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
  /** 渲染层正在展示的 subagent callId：主进程据此让这些指针穿透 MAX_CALLS 尾窗，
   *  保证老工作流卡片也能读到 asyncDir/status.json 的终态校正（不穿透则永远假活）。 */
  pinned?: () => string[] | undefined;
  recover: (key: string, leaf?: string, pinned?: string[]) => Promise<RecoveredSubagent[]>;
  isCurrent: () => boolean;
  publish: (records: RecoveredSubagent[]) => void;
  interval?: number;
}): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // 大会话（数百子代理）空闲时快照完全不变，却每 2s 重算 + IPC + setState →
  // 整列表重渲染（实测 main 40% + renderer 25%：CppHeap GC 风暴 + 全列表
  // reconcile 字体重排）。两道闸：①快照与上次相同 → 不 publish（renderer 零渲染）；
  // ②无 running/queued 子代理 → 轮询退避 2s→10s（状态只能靠轮询发现，事件层
  // 不覆盖 harness 派生的 async 子代理，所以不能完全停）。
  let lastSignature = '';
  let lastRecords: unknown[] = [];
  const tick = async () => {
    const leaf = options.leaf?.();
    try {
      const records = await options.recover(options.key, leaf, options.pinned?.());
      // Branch consistency: a response carries data for the branch selected at
      // request time. If the user switched branches meanwhile (leaf changed),
      // drop it — the next tick reads the current branch. Only meaningful when
      // a branch was explicitly selected (undefined = trunk, always current).
      if (stopped || !options.isCurrent() || (leaf && options.leaf && options.leaf() !== leaf) || !Array.isArray(records)) return;
      // 轻量签名：JSON.stringify 全量快照（含子转录）每拍几 MB 文本，本身就是
      // 分配风暴。状态变化必经这些字段（snapshotAt 是主进程读 status.json 的
      // mtime 戳，文件没变它不变——深层 details 也不会变）。
      const sig = records.map(r => {
        const d = (r as { details?: { snapshotAt?: number; runId?: string } }).details;
        return `${(r as { callId?: string }).callId}|${(r as { status?: string }).status}|${(r as { error?: string }).error ?? ''}|${(r as { startedAt?: number }).startedAt ?? ''}|${d?.snapshotAt ?? ''}|${d?.runId ?? ''}`;
      }).join('\n');
      if (sig !== lastSignature) { lastSignature = sig; lastRecords = records; options.publish(records); }
    } catch { /* IPC transport failure is not a completion observation. Retry. */ }
    finally {
      if (!stopped && options.isCurrent()) {
        const idle = lastSignature !== '' && !lastRecords.some(r => (r as { status?: string })?.status === 'running' || (r as { status?: string })?.status === 'queued');
        timer = setTimeout(() => { void tick(); }, idle ? 10_000 : (options.interval ?? 2000));
      }
    }
  };
  void tick();
  return () => { stopped = true; clearTimeout(timer); };
}
