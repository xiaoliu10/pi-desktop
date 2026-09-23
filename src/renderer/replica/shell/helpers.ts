/**
 * Pure helpers for the replica shell (U02). Kept framework-free so the
 * preview tests can exercise them without a DOM.
 */

import type { ProjectNavItem, SessionNavItem } from '../contracts';

/** Filters session rows by a case-insensitive substring query. */
export function filterSessions(items: SessionNavItem[], query: string): SessionNavItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((s) => s.title.toLowerCase().includes(q));
}

/** Builds the sidebar session list: filtered temporary + per-project lists. */
export function buildSidebarLists(
  temporary: SessionNavItem[],
  projects: ProjectNavItem[],
  query: string,
): { temporary: SessionNavItem[]; projects: ProjectNavItem[] } {
  return {
    temporary: filterSessions(temporary, query),
    projects: projects.map((p) => ({ ...p, sessions: filterSessions(p.sessions, query) })),
  };
}

/** Expanded projects show only this many most-recent sessions until "show all". */
export const SIDEBAR_SESSION_LIMIT = 5;

/** Sessions visible under an expanded project: first N, or all once expanded. */
export function visibleSessions(items: SessionNavItem[], showAll: boolean): SessionNavItem[] {
  return showAll ? items : items.slice(0, SIDEBAR_SESSION_LIMIT);
}

/** Compact relative time for session rows, e.g. "12:31" today / "Sep 18". */
export function formatSessionTime(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const sameDay = new Date(now).toDateString() === d.toDateString();
  if (sameDay) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Truncate for single-line display with an ellipsis (mirrors CSS clipping in tests). */
export function ellipsize(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}
