import type { SubagentChild } from './subagents';

/** Dismissals are persisted by tool call, which can contain several children.
 * Never hide live siblings when removing an ended parallel/chain child.
 * Keep the directory's existing ended states (including skipped/unknown).
 */
export function dismissibleSubagentCalls(children: SubagentChild[]): string[] {
  const calls = new Set(children.map(child => child.callId));
  for (const child of children) {
    if (child.status === 'running' || child.status === 'queued') calls.delete(child.callId);
  }
  return [...calls];
}
