/** Workflow states are owned by the plugin, never by the parent RPC lifecycle. */
export type WorkflowState = 'running' | 'queued' | 'completed' | 'failed' | 'interrupted' | 'unknown';
export function workflowState(value: unknown): WorkflowState {
  if (value === 'running' || value === 'completed' || value === 'failed') return value;
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
