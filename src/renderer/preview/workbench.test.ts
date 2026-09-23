import { beforeEach, describe, expect, it } from 'vitest';
import { demoNotifications, demoSearchItems, demoWorkbenchDiffs, demoWorkbenchFiles } from './fixtures';
import { useDemoStore } from './adapter';

describe('U06 workbench demo data', () => {
  it('diff stats match the line contents', () => {
    for (const d of demoWorkbenchDiffs) {
      const additions = d.lines.filter((l) => l.type === '+').length;
      const deletions = d.lines.filter((l) => l.type === '-').length;
      expect(d.additions).toBe(additions);
      expect(d.deletions).toBe(deletions);
    }
  });

  it('every file node has a selectable path and excerpt', () => {
    const files = demoWorkbenchFiles();
    expect(files.length).toBeGreaterThanOrEqual(2);
    for (const f of files) {
      expect(f.path).toBeTruthy();
      expect(f.excerpt.length).toBeGreaterThan(0);
    }
  });
});

describe('U06 workbench & overlay state', () => {
  beforeEach(() => useDemoStore.getState().reset());

  it('panel toggle, tab select and file select are tracked', () => {
    const store = useDemoStore.getState();
    expect(useDemoStore.getState().workbenchOpen).toBe(false);
    store.toggleWorkbench();
    expect(useDemoStore.getState().workbenchOpen).toBe(true);
    store.selectWorkbenchTab('files');
    expect(useDemoStore.getState().workbenchTab).toBe('files');
    store.selectFile('src/theme-tokens.css');
    expect(useDemoStore.getState().selectedFile).toBe('src/theme-tokens.css');
    store.toggleWorkbench();
    expect(useDemoStore.getState().workbenchOpen).toBe(false);
  });

  it('notifications: unread count, mark all read, request item present', () => {
    const store = useDemoStore.getState();
    expect(store.notifications.filter((n) => !n.read).length).toBeGreaterThan(0);
    expect(store.notifications.some((n) => n.kind === 'request')).toBe(true);
    store.markAllRead();
    expect(useDemoStore.getState().notifications.every((n) => n.read)).toBe(true);
  });

  it('search items cover sessions, messages, pages, settings and commands', () => {
    const kinds = new Set(demoSearchItems('en').map((i) => i.kind));
    expect(kinds.has('session')).toBe(true);
    expect(kinds.has('message')).toBe(true);
    expect(kinds.has('page')).toBe(true);
    expect(kinds.has('setting')).toBe(true);
    expect(kinds.has('command')).toBe(true);
  });

  it('reset restores pristine demo state', () => {
    const store = useDemoStore.getState();
    store.toggleWorkbench();
    store.selectSession('sess-cli-refactor');
    store.reset();
    const state = useDemoStore.getState();
    expect(state.workbenchOpen).toBe(false);
    expect(state.activeSessionId).toBe('sess-plugin-ui');
    expect(state.theme).toBe('light');
    expect(state.notifications.some((n) => !n.read)).toBe(true);
  });
});
