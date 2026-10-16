/** Workflow states are owned by the plugin, never by the parent RPC lifecycle. */
export type WorkflowState = 'running' | 'queued' | 'completed' | 'failed' | 'interrupted' | 'unknown';
export function workflowState(value: unknown): WorkflowState {
  if (value === 'running' || value === 'completed' || value === 'failed') return value;
  if (value === 'complete') return 'completed'; // pi-subagents uses 'complete' for single runs
  if (value === 'pending' || value === 'queued') return 'queued';
  if (['paused', 'stopped', 'aborted', 'cancelled', 'interrupted'].includes(String(value))) return 'interrupted';
  if (value === 'rejected') return 'failed';
  return 'unknown';
}
export const workflowObject = (value: unknown): Record<string, any> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : undefined;
export const workflowText = (value: unknown, max = 256): string => typeof value === 'string' ? value.slice(0, max) : '';
export const workflowId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(value);
/**
 * pi-subagents >=0.79 的第三种结果形态：run 结束后 tool result 只带
 * `{token, runId, outcome, completions:[{agent, mode:'single', state, success,
 * results:[{agent, sessionFile, outputState, ...}], archivePath}]}`——既非 workflow
 * （无 mode/steps/workflowChildren）也非 singleAsyncDetails（无顶层 mode/asyncDir）。
 * 子会话转录指针在 completions[].results[].sessionFile 里，不解析这层详情面板
 * 就拿不到 childKey（用户实测：详情面板永久转圈/「不可用」）。
 * 规范成 singleAsyncDetails 同款形状（mode:'single' + runId + sessionFile），
 * 复用同一套指针链路；asyncDir 缺失时指针回退为 completions 内 sessionFile。
 */
export function completionsDetails(value: unknown, callId: string): Record<string, any> | undefined {
  const d = workflowObject(value);
  if (!d || !Array.isArray(d.completions) || d.completions.length === 0) return undefined;
  if (d.toolCallId !== undefined && d.toolCallId !== callId) return undefined;
  for (const entry of d.completions) {
    const c = workflowObject(entry);
    if (!c || c.mode !== 'single') continue;
    if (c.toolCallId !== undefined && c.toolCallId !== callId) continue;
    const results = Array.isArray(c.results) ? c.results.filter(workflowObject) : [];
    const hit = results.find(r => typeof r.sessionFile === 'string');
    if (!hit) continue;
    const runId = workflowId(c.runId) ? c.runId : workflowId(d.runId) ? d.runId : undefined;
    if (!runId) continue;
    // sessionFile 由 completions 携带；asyncDir 保持缺省（指针链路按 runId 走 expectedDir，
 // 缺 asyncDir 时 childSessionPointer 的 completions 分支直接用这个 sessionFile）。
    return { ...c, ...d, runId, mode: 'single', results, sessionFile: hit.sessionFile, __fromCompletions: true };
  }
  return undefined;
}
/** Reject management replies, including status replies which themselves contain run metadata. */
export function isSubagentManagement(argumentsText?: string): boolean {
  try { const args = JSON.parse(argumentsText || '{}'); return typeof args?.action === 'string' && args.action !== ''; } catch { return false; }
}
export function workflowDetails(value: unknown, callId: string) {
  const d = workflowObject(value), w = workflowObject(d?.workflowChildren);
  if (d?.mode !== 'workflow' || !workflowId(d.runId) || (d.toolCallId !== undefined && d.toolCallId !== callId)) return undefined;
  if (w && (w.version !== 1 || w.parentToolCallId !== callId || w.workflowRunId !== d.runId || !Array.isArray(w.children))) return undefined;
  if (!w && !Array.isArray(d.steps)) return undefined;
  return d;
}
/** pi-subagents >=0.78 asynchronous SINGLE run: a detached child whose live state lives
 *  in `<asyncDir>/status.json` (mode:'single', state, steps[0]) rather than in the
 *  tool result's `results[]`. The result returns immediately (detached), so `results`
 *  is empty/absent and the adapter must synthesize one child row bound by runId.
 *  Management replies (status/guide/list) also report mode:'single' with empty results
 *  but carry no runId/asyncDir, so they are excluded here and by isSubagentManagement. */
export function singleAsyncDetails(value: unknown, callId: string) {
  const d = workflowObject(value);
  if (!d || d.mode !== 'single') return undefined;
  if (!workflowId(d.runId) || typeof d.asyncDir !== 'string') return undefined;
  if (d.toolCallId !== undefined && d.toolCallId !== callId) return undefined;
  // Non-empty results belong to the official adapter (synchronous single/parallel/chain).
  if (Array.isArray(d.results) && d.results.length > 0) return undefined;
  return d;
}
/** Stable keys; never fall back to a position in a growing/reordered inventory. */
export function workflowRows(d: Record<string, any>): Record<string, any>[] {
  const steps = Array.isArray(d.steps) ? d.steps.filter(workflowObject) : [];
  const inventory = Array.isArray(d.workflowChildren?.children) ? d.workflowChildren.children.filter(workflowObject) : [];
  const rows = new Map<string, Record<string, any>>();
  for (const row of [...inventory, ...steps]) {
    const match = inventory.find((c: any) => (row.workflowKey && c.childId === row.workflowKey) || (row.runId && c.runId === row.runId));
    const key = row.workflowKey || match?.childId || row.childId || row.runId;
    if (!workflowId(key)) continue;
    const previous = rows.get(key);
    rows.set(key, { ...previous, ...row, childId: key, state: row.status ?? row.state ?? previous?.state });
  }
  return [...rows.values()].slice(0, 128);
}
/** One synthesized child row for an asynchronous single run, derived from its
 *  `status.json`. childId is the stable literal 'single' so live and disk rows
 *  merge by runId. Only display fields; never prompts/transcripts/sessionFile. */
export function singleRunRow(status: Record<string, any>): Record<string, any> {
  const step = Array.isArray(status.steps) ? workflowObject(status.steps[0]) : undefined;
  const tokens = workflowObject(status.totalTokens);
  return {
    childId: 'single',
    runId: workflowId(status.runId) ? status.runId : undefined,
    agent: workflowText(step?.agent),
    label: workflowText(step?.label),
    state: workflowState(status.state ?? step?.status),
    model: workflowText(step?.model),
    tokens: tokens && typeof tokens.total === 'number' && Number.isFinite(tokens.total) ? tokens.total : undefined,
    turns: typeof status.turnCount === 'number' && Number.isFinite(status.turnCount) ? status.turnCount : undefined,
    snapshotAt: typeof status.lastUpdate === 'number' && Number.isFinite(status.lastUpdate) ? status.lastUpdate : undefined,
  };
}
