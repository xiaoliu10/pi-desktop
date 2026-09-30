import { describe, expect, it } from 'vitest';
import { buildPiSidebar } from '../src/renderer/pi/adapter';
import type { PiRun, PiSession } from '../src/shared/pi';
import type { DesktopProject } from '../src/shared/projects';

const session = (cwd: string, key: string, updatedAt: number, owned = true): PiSession => ({
  cwd, key, id: key, path: `${cwd}/${key}.jsonl`, name: key, updatedAt, owned, size: 1, warnings: [],
});
const run = (cwd: string, key: string, status: PiRun['status']): PiRun => ({
  cwd, key, status, generation: 'g', file: '', pending: 0, models: [], commands: [],
});
const paths = (sidebar: ReturnType<typeof buildPiSidebar>) => sidebar.projects.map(p => p.path);

// Intentionally neither alphabetical nor activity order, and pinned rows have different sections.
const projects: DesktopProject[] = [
  { path: '/w/z-work', name: 'Z work', section: 'Work' },
  { path: '/w/z-pin', name: 'Z pinned', pinned: true, section: 'Work' },
  { path: '/w/z-plain', name: 'Z plain' },
  { path: '/w/a-pin', name: 'A pinned', pinned: true, section: 'Personal' },
  { path: '/w/a-work', name: 'A work', section: 'Work' },
  { path: '/w/a-personal', name: 'Personal', section: 'Personal' },
  { path: '/w/a-plain', name: 'A plain' },
];
const expected = ['/w/z-pin', '/w/a-pin', '/w/a-personal', '/w/z-work', '/w/a-work', '/w/z-plain', '/w/a-plain', '/w/auto-a', '/w/auto-z'];

describe('stable sidebar project order', () => {
  it('orders discovered projects by full path, independent of activity and input order', () => {
    // Basenames deliberately run opposite to the full paths.
    const input = [session('/w/z/a', 'z', 100), session('/w/a/z', 'a', 1)];
    for (const sessions of [input, [...input].reverse(), input.map(s => ({ ...s, updatedAt: 1 }))]) {
      expect(paths(buildPiSidebar(sessions, [], [], {}))).toEqual(['/w/a/z', '/w/z/a']);
    }
  });

  it('keeps saved order within pinned/section/default groups through progress, new sessions and reordered input', () => {
    const cwds = [...projects.map(p => p.path), '/w/auto-z', '/w/auto-a'];
    const original = cwds.flatMap((cwd, i) => [session(cwd, `${i}-old`, i + 1), session(cwd, `${i}-new`, 100 + i)]);
    for (let tick = 0; tick < cwds.length; tick++) {
      const hot = cwds[tick];
      const updated = original.map(s => ({ ...s, updatedAt: s.cwd === hot ? s.updatedAt + 10000 : s.updatedAt }));
      updated.push(session(hot, 'newly-added', 20000));
      const rotated = [...updated.slice(tick), ...updated.slice(0, tick)];
      if (tick % 2) rotated.reverse();
      const before = JSON.stringify(rotated);
      const runs = rotated.map((s, i) => run(s.cwd, s.key, ['running', 'idle', 'starting'][i % 3] as PiRun['status']));
      const sidebar = buildPiSidebar(rotated, runs.reverse(), cwds, {}, { projects, hiddenProjects: [] });
      expect(paths(sidebar)).toEqual(expected);
      for (const p of sidebar.projects) {
        const times = p.sessions.map(s => s.updatedAt);
        expect(times).toEqual([...times].sort((a, b) => b - a));
        expect(p.expanded).toBe(true);
        for (const s of p.sessions) expect(s.busy).toBe(runs.find(r => r.key === s.id)!.status !== 'idle');
      }
      expect(sidebar.projects.find(p => p.path === hot)!.sessions[0].id).toBe('newly-added');
      expect(JSON.stringify(rotated)).toBe(before);
    }
  });

  it('uses saved order rather than project names, even after renaming', () => {
    const sessions = [...projects].reverse().map((p, i) => session(p.path, String(i), 100 - i));
    for (const named of [projects, projects.map((p, i) => ({ ...p, name: `renamed-${99 - i}` }))]) {
      const sidebar = buildPiSidebar(sessions, [], [], {}, { projects: named, hiddenProjects: [] });
      expect(paths(sidebar)).toEqual(expected.slice(0, -2));
      for (const p of sidebar.projects) expect(p.name).toBe(named.find(n => n.path === p.path)!.name);
    }
  });

  it('keeps session recency, renames and CLI continuation independent of project ordering', () => {
    const input = [session('/w/z', 'old', 1, false), session('/w/a', 'other', 999), session('/w/z', 'recent', 10)];
    const prefs = { projects: [{ path: '/w/z', name: 'Z' }, { path: '/w/a', name: 'A' }], hiddenProjects: [] };
    const first = buildPiSidebar(input, [], [], { old: 'Renamed session' }, prefs);
    expect(paths(first)).toEqual(['/w/z', '/w/a']);
    expect(first.projects[0].sessions.map(s => s.id)).toEqual(['recent', 'old']);
    expect(first.projects[0].sessions[1]).toMatchObject({ title: 'Renamed session', source: 'pi-cli', canContinue: true });
    const second = buildPiSidebar(input.map(s => s.key === 'old' ? { ...s, updatedAt: 5000 } : s).reverse(), [run('/w/z', 'old', 'running')], [], {}, prefs);
    expect(paths(second)).toEqual(paths(first));
    expect(second.projects[0].sessions.map(s => s.id)).toEqual(['old', 'recent']);
    expect(second.projects[0].sessions[0]).toMatchObject({ busy: true, canContinue: false });
  });

  it('preserves empty and archive-only projects, hidden filtering and orphan runs', () => {
    const prefs = { projects: [
      { path: '/w/empty', name: 'Empty', pinned: true },
      { path: '/w/hidden', name: 'Hidden', pinned: true },
      { path: '/w/registered-archive', name: 'Archive', section: 'Work' },
    ], hiddenProjects: ['/w/hidden', '/w/hidden-discovered', '/w/hidden-orphan'] };
    const sessions = [session('/w/registered-archive', 'archived', 900), session('/w/auto-archive', 'auto-archived', 800),
      session('/w/hidden', 'hidden', 700), session('/w/hidden-discovered', 'hidden-discovered', 600), session('/w/auto-live', 'live', 1)];
    const runs = [run('/w/registered-archive', 'archived', 'running'), run('/w/auto-live', 'live', 'idle'),
      run('/w/orphan-only', 'orphan', 'starting'), run('/w/hidden-orphan', 'hidden-orphan', 'running'), run('/w/empty', 'empty-orphan', 'idle')];
    const sidebar = buildPiSidebar(sessions, runs, ['/w/empty', '/w/auto-archive'], {}, prefs, ['archived', 'auto-archived']);
    expect(paths(sidebar)).toEqual(['/w/empty', '/w/registered-archive', '/w/auto-archive', '/w/auto-live']);
    expect(sidebar.projects.slice(0, 3).map(p => [p.emptyHint, p.sessions.length])).toEqual([[true, 0], [true, 0], [true, 0]]);
    expect(sidebar.projects[2]).toMatchObject({ name: 'auto-archive', expanded: true });
    expect(sidebar.temporary.map(s => [s.id, s.busy])).toEqual([['orphan', true], ['empty-orphan', false]]);
    expect(sidebar.projects[3].sessions[0]).toMatchObject({ id: 'live', busy: false });
  });

  it('renders saved empty projects without sessions and tolerates missing preferences', () => {
    expect(buildPiSidebar([], [], [], {})).toEqual({ temporary: [], projects: [] });
    const prefs = { projects, hiddenProjects: [] };
    const before = JSON.stringify(prefs);
    expect(paths(buildPiSidebar([], [], [], {}, prefs))).toEqual(expected.slice(0, -2));
    expect(JSON.stringify(prefs)).toBe(before);
  });
});
