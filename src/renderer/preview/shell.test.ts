import { describe, expect, it } from 'vitest';
import { buildSidebarLists, ellipsize, filterSessions, formatSessionTime } from '../replica/shell/helpers';
import { demoProjectSessions, demoTemporarySessions } from './fixtures';
import type { ProjectNavItem } from '../replica/contracts';

const temp = demoTemporarySessions('en');
const projects: ProjectNavItem[] = [
  { id: 'proj-apps', name: 'apps', path: '/w/apps', expanded: true, emptyHint: false, sessions: demoProjectSessions('en')['proj-apps'] ?? [] },
  { id: 'proj-web', name: 'web-site', path: '/w/web', expanded: true, emptyHint: true, sessions: [] },
];

describe('U02 shell helpers', () => {
  it('filters sessions case-insensitively', () => {
    expect(filterSessions(temp, 'cli').map((s) => s.id)).toEqual(['sess-cli-refactor', 'sess-cli-tests']);
    expect(filterSessions(temp, '  UNINSTALL ')).toEqual([temp[2]]);
    expect(filterSessions(temp, '')).toHaveLength(temp.length);
  });

  it('builds sidebar lists and filters nested project sessions', () => {
    const lists = buildSidebarLists(temp, projects, 'configure');
    expect(lists.temporary).toHaveLength(0);
    expect(lists.projects[0].sessions.map((s) => s.id)).toEqual(['sess-config']);
    expect(lists.projects[1].sessions).toHaveLength(0);
  });

  it('formats today as time and older dates as a date', () => {
    const now = new Date('2026-09-20T12:00:00').getTime();
    expect(formatSessionTime(new Date('2026-09-20T09:05:00').getTime(), now)).toBe('09:05');
    expect(formatSessionTime(new Date('2026-09-18T09:05:00').getTime(), now)).toBe('Sep 18');
  });

  it('marks pi CLI sessions distinctly from desktop sessions', () => {
    const cli = temp.filter((s) => s.source === 'pi-cli');
    expect(cli.length).toBeGreaterThanOrEqual(2);
    for (const s of cli) {
      expect(s.syncedAt).toBeTruthy();
      expect(s.canContinue).toBe(true);
    }
    expect(temp.some((s) => s.source === 'desktop')).toBe(true);
  });

  it('ellipsizes long titles', () => {
    expect(ellipsize('abcdefgh', 5)).toBe('abcd…');
    expect(ellipsize('abc', 5)).toBe('abc');
  });
});
