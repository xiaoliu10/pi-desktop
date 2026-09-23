import { afterEach, expect, it, vi } from 'vitest';
import { usePiStore } from '../src/renderer/pi/adapter';
afterEach(() => vi.unstubAllGlobals());
it('registers a directory, updates the sidebar, and opens a task in that project', async () => {
 const preferences = { projects: [{ path: '/work/demo', name: 'demo' }] };
 const api = { pickDirectory: vi.fn().mockResolvedValue('/work/demo'), projectSave: vi.fn().mockResolvedValue(undefined), settingsSnapshot: vi.fn().mockResolvedValue({ preferences }) };
 vi.stubGlobal('window', { localPi: api });
 usePiStore.setState({ addingProject: false, selectedKey: null, expandedProjects: [], runs: [], sessions: [] });
 usePiStore.getState().addProject();
 await vi.waitFor(() => expect(usePiStore.getState().addingProject).toBe(false));
 expect(api.projectSave).toHaveBeenCalledWith({ path: '/work/demo', name: 'demo' });
 expect(usePiStore.getState()).toMatchObject({ view: 'home', draftCwd: '/work/demo', desktopPreferences: preferences, expandedProjects: ['/work/demo'] });
});
it('cancelling the chooser leaves the current task and projects unchanged', async () => {
 const api = { pickDirectory: vi.fn().mockResolvedValue(null), projectSave: vi.fn() };
 vi.stubGlobal('window', { localPi: api });
 usePiStore.setState({ addingProject: false, selectedKey: 'existing', draftText: 'unsent', expandedProjects: ['/existing'] });
 usePiStore.getState().addProject();
 await vi.waitFor(() => expect(usePiStore.getState().addingProject).toBe(false));
 expect(api.projectSave).not.toHaveBeenCalled();
 expect(usePiStore.getState()).toMatchObject({ selectedKey: 'existing', draftText: 'unsent', expandedProjects: ['/existing'] });
});
