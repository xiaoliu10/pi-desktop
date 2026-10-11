import type { SubagentChild } from './subagents';

/** Dismissal granularity is a single child (`callId:index`). A callId can hold
 * several children (parallel/chain); hiding the whole call used to be the only
 * option, which permanently locked an ended (e.g. failed) row while a sibling
 * kept running — the × appeared dead. Child-level ids never hide live siblings
 * by construction. Legacy persisted entries store whole callIds; the render
 * filter matches both (`c.id` and `c.callId`).
 */
export function dismissibleSubagentIds(children: SubagentChild[]): string[] {
  return children.filter(child => child.status !== 'running' && child.status !== 'queued').map(child => child.id);
}
