import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetComposerDrafts, usePiStore } from '../src/renderer/pi/adapter';
import type { PiHistory, PiRun, PiSession } from '../src/shared/pi';

const sourceKey = 'external-source';
const copyKey = 'desktop-copy';
const session = (key: string, owned: boolean): PiSession => ({ key, id: key, cwd: '/mock/project', path: `/mock/${key}.jsonl`, name: 'External conversation', updatedAt: owned ? 2 : 1, size: 100, warnings: [], owned, ...(owned ? { parentSession: '/mock/external-source.jsonl' } : {}) });
const history = (key: string): PiHistory => ({ session: session(key, key === copyKey), entries: [], branch: [{ id: key === copyKey ? 'latest-desktop-answer' : 'old-external-answer', type: 'message', message: { role: 'assistant', content: key } }], leaves: [], leafId: null, syncedAt: 1 } as PiHistory);
const run: PiRun = { key: copyKey, generation: 'copy-gen', cwd: '/mock/project', file: '/mock/desktop-copy.jsonl', status: 'idle', models: [], commands: [], pending: 0 };
let api: any;

beforeAll(() => {
  vi.useFakeTimers();
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
  api = { resolveSession: vi.fn(async () => copyKey), history: vi.fn(async (key: string) => history(key)), connect: vi.fn(async () => run), prompt: vi.fn(async () => undefined) };
  vi.stubGlobal('window', { localPi: api });
});
beforeEach(async () => {
  await vi.advanceTimersByTimeAsync(1000);
  vi.clearAllMocks();
  api.resolveSession.mockReset().mockResolvedValue(copyKey);
  api.connect.mockReset().mockResolvedValue(run);
  api.history.mockReset().mockImplementation(async (key: string) => history(key));
  resetComposerDrafts();
  usePiStore.setState({ selectedKey: null, view: 'home', env: { supported: true } as any, sessions: [session(sourceKey, false), session(copyKey, true)], runs: [], history: undefined, leaf: undefined, connecting: false, changingAccessMode: false, archivedKeys: [], desktopPreferences: undefined, draftText: '', contextItems: [], draftModelId: undefined, draftThinking: undefined, sends: [], live: {}, toolProgress: {}, sentAt: undefined, pendingPrompt: undefined, pendingPromptAt: undefined, error: undefined });
});
afterAll(async () => { await vi.advanceTimersByTimeAsync(1000); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('external conversation: reading must use the same target as sending', () => {
  it.each(['archived', 'capacity', 'offline', 'connect-error'])('read-only routing still works when prewarming is unavailable: %s', async reason => {
    if (reason === 'archived') usePiStore.setState({ archivedKeys: [sourceKey] });
    if (reason === 'capacity') usePiStore.setState({ runs: [0, 1, 2, 3].map(i => ({ ...run, key: 'other-' + i })) });
    if (reason === 'offline') usePiStore.setState({ env: { supported: false } as any });
    if (reason === 'connect-error') api.connect.mockRejectedValue(new Error('runtime unavailable'));
    usePiStore.getState().selectSession(sourceKey);
    await vi.advanceTimersByTimeAsync(1000);
    expect(usePiStore.getState().selectedKey).toBe(copyKey);
    expect(usePiStore.getState().history?.branch.at(-1)?.id).toBe('latest-desktop-answer');
    expect(api.prompt).not.toHaveBeenCalled();
  });

  it('does not redirect once a runtime already owns the source key', async () => {
    usePiStore.setState({ runs: [{ ...run, key: sourceKey }] });
    usePiStore.getState().selectSession(sourceKey);
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.resolveSession).not.toHaveBeenCalled();
    expect(usePiStore.getState().selectedKey).toBe(sourceKey);
    expect(api.history).toHaveBeenCalledWith(sourceKey, undefined, expect.any(Object));
  });

  it('re-redirecting is idempotent: the copy is owned so it never re-enters the branch', async () => {
    usePiStore.setState({ env: { supported: false } as any });
    usePiStore.getState().selectSession(sourceKey);
    await vi.advanceTimersByTimeAsync(1000);
    usePiStore.getState().selectSession(copyKey);
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.resolveSession).toHaveBeenCalledTimes(1);
    expect(usePiStore.getState().selectedKey).toBe(copyKey);
  });

  it('does not redirect an explicitly selected branch', async () => {
    usePiStore.setState({ env: { supported: false } as any });
    usePiStore.getState().selectSession(sourceKey);
    usePiStore.setState({ leaf: 'chosen-old-branch' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.resolveSession).not.toHaveBeenCalled();
    expect(api.history).toHaveBeenCalledWith(sourceKey, 'chosen-old-branch', expect.any(Object));
    expect(usePiStore.getState().selectedKey).toBe(sourceKey);
  });

  it('keeps an original without a Desktop copy and leaves owned conversations untouched', async () => {
    api.resolveSession.mockResolvedValue(sourceKey);
    usePiStore.setState({ env: { supported: false } as any });
    usePiStore.getState().selectSession(sourceKey);
    await vi.advanceTimersByTimeAsync(1000);
    expect(usePiStore.getState().selectedKey).toBe(sourceKey);
    expect(usePiStore.getState().history?.branch.at(-1)?.id).toBe('old-external-answer');
    usePiStore.getState().selectSession(copyKey);
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.resolveSession).toHaveBeenCalledTimes(1);
  });

  it('late routing responses never pull the user out of another conversation', async () => {
    let resolve!: (key: string) => void;
    api.resolveSession.mockImplementation(() => new Promise<string>(done => { resolve = done; }));
    usePiStore.setState({ env: { supported: false } as any });
    usePiStore.getState().selectSession(sourceKey);
    await vi.advanceTimersByTimeAsync(450);
    usePiStore.getState().selectSession('another-conversation');
    resolve(copyKey);
    await vi.advanceTimersByTimeAsync(1000);
    expect(usePiStore.getState().selectedKey).toBe('another-conversation');
    expect(api.history.mock.calls.every(([key]: [string]) => key !== copyKey)).toBe(true);
  });

  it('a late source history reply cannot overwrite the target history', async () => {
    let resolve!: (value: PiHistory) => void;
    api.resolveSession.mockResolvedValue(sourceKey);
    usePiStore.setState({ env: { supported: false } as any });
    api.history.mockImplementationOnce(() => new Promise<PiHistory>(done => { resolve = done; }));
    usePiStore.getState().selectSession(sourceKey);
    await vi.advanceTimersByTimeAsync(450);
    usePiStore.getState().selectSession(copyKey);
    resolve(history(sourceKey));
    await vi.advanceTimersByTimeAsync(1500);
    expect(usePiStore.getState().selectedKey).toBe(copyKey);
    expect(usePiStore.getState().history?.branch.at(-1)?.id).toBe('latest-desktop-answer');
  });

  it('retargets the current navigation entry without adding an extra Back step', async () => {
    usePiStore.setState({ navHistory: { entries: [{ view: 'home' }, { view: 'chat', key: sourceKey }, { view: 'settings' }], cursor: 1 }, env: { supported: false } as any });
    usePiStore.getState().selectSession(sourceKey);
    usePiStore.getState().setDraftText('unsent while opening');
    await vi.advanceTimersByTimeAsync(1000);
    expect(usePiStore.getState().draftText).toBe('unsent while opening');
    expect(usePiStore.getState().navHistory).toEqual({ entries: [{ view: 'home' }, { view: 'chat', key: copyKey }, { view: 'settings' }], cursor: 1 });
  });
  it('merges both unsent drafts and attachments, preserves navigation and restores them on reopen', async () => {
    usePiStore.setState({ env: { supported: false } as any });
    const targetItem = { id: 'target-file', name: 'target', path: '/target', kind: 'file' as const, text: 'target attachment' };
    const sourceItem = { id: 'source-file', name: 'source', path: '/source', kind: 'file' as const, text: 'source attachment' };
    const shared = { id: 'shared-file', name: 'shared', path: '/shared', kind: 'file' as const, text: 'shared attachment' };
    usePiStore.getState().selectSession(copyKey);
    usePiStore.getState().setDraftText('TARGET_UNSENT');
    usePiStore.getState().addContext([targetItem, shared]);
    usePiStore.getState().selectSession('elsewhere');
    usePiStore.getState().selectSession(sourceKey);
    usePiStore.getState().setDraftText('SOURCE_UNSENT');
    usePiStore.getState().addContext([sourceItem, shared]);
    const beforeNav = usePiStore.getState().navHistory;
    await vi.advanceTimersByTimeAsync(1000);
    const merged = 'TARGET_UNSENT\n\n---\n\nSOURCE_UNSENT';
    expect(usePiStore.getState().draftText).toBe(merged);
    expect(usePiStore.getState().contextItems).toEqual([targetItem, shared, sourceItem]);
    expect(usePiStore.getState().navHistory).toEqual({ ...beforeNav, entries: beforeNav.entries.map((e, i) => i === beforeNav.cursor ? { ...e, key: copyKey } : e) });
    usePiStore.getState().selectSession('elsewhere');
    usePiStore.getState().selectSession(copyKey);
    await vi.advanceTimersByTimeAsync(1000);
    expect(usePiStore.getState().draftText).toBe(merged);
    expect(usePiStore.getState().contextItems).toEqual([targetItem, shared, sourceItem]);
  });

  it('opening the external source must display its resumed Desktop history without a new message', async () => {
    usePiStore.getState().selectSession(sourceKey);
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.connect).toHaveBeenCalledTimes(1);
    expect(api.prompt).not.toHaveBeenCalled();
    expect(usePiStore.getState().selectedKey).toBe(copyKey);
    expect(usePiStore.getState().history?.branch.at(-1)?.id).toBe('latest-desktop-answer');
  });

  it('baseline contrast: sending switches to the Desktop key and reveals its existing history', async () => {
    usePiStore.getState().selectSession(sourceKey);
    await vi.advanceTimersByTimeAsync(1000);
    usePiStore.getState().send('follow up');
    await vi.advanceTimersByTimeAsync(1500);
    expect(api.prompt).toHaveBeenCalledWith(copyKey, 'follow up', expect.any(String));
    expect(usePiStore.getState().selectedKey).toBe(copyKey);
    expect(usePiStore.getState().history?.branch.at(-1)?.id).toBe('latest-desktop-answer');
  });
});
