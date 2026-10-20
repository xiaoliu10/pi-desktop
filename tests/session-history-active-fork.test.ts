import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { PiBackend } from '../src/main/pi/backend';
import { BUILTIN_PACKAGES } from '../src/main/pi/builtin-packages';
import { PiRpcClient } from '../src/main/pi/rpc-client';
import { SessionIndex, fileKey } from '../src/main/pi/session-index';
import { buildPiSidebar, currentRunOf, resetComposerDrafts, usePiStore } from '../src/renderer/pi/adapter';

const roots: string[] = [];
const backends: PiBackend[] = [];
afterEach(async () => {
  backends.splice(0).forEach(b => b.dispose());
  // Let in-flight history refreshes settle before removing their fixture files.
  await new Promise(resolve => setTimeout(resolve, 1000));
  vi.unstubAllGlobals();
  roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }));
});

it.each(['offline', 'prewarm', 'late-prewarm'] as const)('real connect/fork keeps tip history and stable runtime/send identity (%s)', async scenario => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'history-active-fork-')));
  roots.push(root);
  fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ packages: BUILTIN_PACKAGES.map(p => p.spec) }));
  const owned = path.join(root, 'desktop'); fs.mkdirSync(owned);
  const source = path.join(root, 'source.jsonl');
  fs.writeFileSync(source, JSON.stringify({ type: 'session', version: 3, id: 'source', cwd: root }) + '\n' + JSON.stringify({ type: 'message', id: 'old-source', message: { role: 'assistant', content: 'old-source' } }) + '\n');
  const original = fs.readFileSync(source);
  const index = new SessionIndex([root], owned); index.scan();
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
  resetComposerDrafts();
  usePiStore.setState({ selectedKey: null, view: 'home', runs: [], history: undefined, leaf: undefined, connecting: false, changingAccessMode: false, archivedKeys: [], desktopPreferences: undefined, draftText: '', contextItems: [], sends: [], live: {}, toolProgress: {}, error: undefined, navHistory: { entries: [{ view: 'home' }], cursor: 0 } });
  const backend = new PiBackend({ supported: true, executable: path.resolve('tests/fixtures/fake-pi.mjs'), agentDir: root, sessionDirs: [root], diagnostics: [] }, index, owned, path.resolve('extensions/desktop-policy/index.mjs'), event => {
    if (event.type === 'run') usePiStore.setState(s => ({ runs: [...s.runs.filter(r => r.key !== event.run.key), structuredClone(event.run)] }));
  }, root);
  backends.push(backend);
  const factory = vi.fn((command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) => new PiRpcClient(command, args, cwd, env));
  backend.clientFactory = factory;
  const copy = await backend.connect({ sourceKey: fileKey(source), trustProject: false, permission: 'ask' });
  // Execute actual backend fork RPC/state/continuation recording, not an injected active map.
  await backend.forkTo(copy.key, 'history-target-fork');
  index.scan();
  const tip = copy.file.replace(/\.jsonl$/, '-tip.jsonl');
  const tipKey = fileKey(tip);
  const resolve = vi.fn(async (key: string) => backend.resolveSessionKey(key));
  const connect = vi.fn(async (input: Parameters<PiBackend['connect']>[0]) => {
    if (scenario === 'late-prewarm') await new Promise(resolve => setTimeout(resolve, 700));
    return backend.connect(input);
  });
  const history = vi.fn(async (key: string, leaf?: string) => index.history(key, leaf));
  const prompt = vi.fn((key: string, text: string, behavior: 'steer' | 'followUp') => backend.prompt(key, text, behavior));
  vi.stubGlobal('window', { localPi: { resolveSession: resolve, connect, history, prompt } });
  usePiStore.setState({ sessions: index.sessionsView(), env: { supported: scenario !== 'offline', diagnostics: [] } });

  expect(backend.resolveSessionKey(fileKey(source))).toBe(tipKey);
  expect((await backend.connect({ sourceKey: fileKey(source), trustProject: false, permission: 'ask' })).key).toBe(copy.key);
  // Opening either the original or its stable runtime key must read the actual tip.
  if (scenario === 'late-prewarm') {
    usePiStore.setState({ runs: [] });
  } else {
    usePiStore.getState().selectSession(copy.key);
    await vi.waitFor(() => expect(usePiStore.getState().history?.branch.at(-1)?.id).toBe('latest-tip'), { timeout: 3000 });
  }
  // Save a draft on the file target as well: alias adoption must not skip it.
  usePiStore.setState({ env: { supported: false, diagnostics: [] }, runs: [] });
  usePiStore.getState().selectSession(tipKey);
  usePiStore.getState().setDraftText('TIP_DRAFT');
  usePiStore.getState().selectSession('elsewhere');
  if (scenario !== 'late-prewarm') usePiStore.setState({ runs: backend.runs() });
  usePiStore.setState({ env: { supported: scenario !== 'offline', diagnostics: [] } });
  usePiStore.getState().selectSession(fileKey(source));
  usePiStore.getState().setDraftText('SOURCE_DRAFT');
  await vi.waitFor(() => expect(usePiStore.getState().history?.branch.at(-1)?.id).toBe('latest-tip'), { timeout: 3000 });
  await vi.waitFor(() => expect(usePiStore.getState().selectedKey).toBe(copy.key), { timeout: 3000 });
  expect(currentRunOf(usePiStore.getState())?.generation).toBe(copy.generation);
  expect(usePiStore.getState().draftText).toBe('TIP_DRAFT\n\n---\n\nSOURCE_DRAFT');
  expect(history.mock.calls.every(([key]) => key === tipKey)).toBe(true);
  expect((await backend.connect({ sourceKey: tipKey, trustProject: false, permission: 'ask' })).generation).toBe(copy.generation);
  const tipSession = index.sessionsView().find(session => session.key === tipKey)!;
  const sidebar = buildPiSidebar([{ ...tipSession, parentSession: undefined }], [{ ...backend.runs()[0], status: 'running' }], [root], {});
  expect(sidebar.temporary).toEqual([]);
  expect(sidebar.projects[0].sessions[0]).toMatchObject({ id: copy.key, busy: true });
  // Explicit leaves stay on the already chosen file, not the obsolete runtime snapshot.
  usePiStore.setState({ leaf: 'latest-tip' });
  await usePiStore.getState().refreshConversation();
  expect(history.mock.calls.at(-1)).toEqual([tipKey, 'latest-tip', expect.any(Object)]);
  usePiStore.setState({ leaf: undefined });
  expect(prompt).not.toHaveBeenCalled();

  usePiStore.setState({ env: { supported: true, diagnostics: [] } });
  usePiStore.getState().send('history-target-followup');
  await vi.waitFor(() => expect(prompt).toHaveBeenCalledWith(copy.key, 'history-target-followup', expect.any(String)), { timeout: 3000 });
  await vi.waitFor(() => expect(usePiStore.getState().history?.branch.at(-1)?.id).toBe('sent-to-tip'), { timeout: 3000 });
  expect(usePiStore.getState().selectedKey).toBe(copy.key);
  expect(backend.runs()).toHaveLength(1);
  expect(factory).toHaveBeenCalledTimes(1);
  expect(fs.readFileSync(source)).toEqual(original);
  expect(index.history(copy.key).branch.at(-1)?.id).toBe('old-source');
  expect(fs.readFileSync(tip, 'utf8')).toContain('sent-to-tip');
  // Stable-key permission writes still reach the mode file used by the same runtime.
  await backend.setAccessMode(copy.key, 'autoEdit');
  expect(fs.readFileSync(path.join(owned, `.mode-${copy.key}`), 'utf8')).toBe('autoEdit');
}, 12000);
