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
