import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { PiBackend } from '../src/main/pi/backend';
import { BUILTIN_PACKAGES } from '../src/main/pi/builtin-packages';
import { PiRpcClient } from '../src/main/pi/rpc-client';
import { SessionIndex, fileKey } from '../src/main/pi/session-index';
import { SessionArchive } from '../src/main/pi/session-archive';
import { applyContinuations, continuationChainKeys, loadContinuations } from '../src/main/pi/session-continuations';
import { recoverSubagents, subagentChildTranscript } from '../src/main/pi/official-subagent';
import { subagentAsyncRoot } from '../src/main/pi/subagent-snapshots';
import { buildPiSidebar, currentRunOf, resetComposerDrafts, usePiStore } from '../src/renderer/pi/adapter';
import type { PiRun } from '../src/shared/pi';

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

// PR148 复审 F-1..F-4 定向回归：fork 链在 run 关闭、子代理查询、侧栏元数据与
// 异步响应四个面上都必须跟随真实链尾文件，而不是退回 runtime key 对应的旧文件。
it('closed run still reads the chain tip; subagent/sidebar/outline/search follow the resolved file key', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'history-active-fork-')));
  roots.push(root);
  const previousAsyncRoot = process.env.PI_SUBAGENTS_TEMP_ROOT;
  process.env.PI_SUBAGENTS_TEMP_ROOT = root;
  try {
    fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ packages: BUILTIN_PACKAGES.map(p => p.spec) }));
    const owned = path.join(root, 'desktop'); fs.mkdirSync(owned);
    const source = path.join(root, 'source.jsonl');
    fs.writeFileSync(source, JSON.stringify({ type: 'session', version: 3, id: 'source', cwd: root }) + '\n' + JSON.stringify({ type: 'message', id: 'old-source', message: { role: 'assistant', content: 'old-source' } }) + '\n');
    const index = new SessionIndex([root], owned); index.scan();
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    resetComposerDrafts();
    usePiStore.setState({ selectedKey: null, view: 'home', runs: [], history: undefined, leaf: undefined, connecting: false, changingAccessMode: false, archivedKeys: [], desktopPreferences: undefined, draftText: '', contextItems: [], sends: [], live: {}, toolProgress: {}, error: undefined, navHistory: { entries: [{ view: 'home' }], cursor: 0 }, outline: [], outlineLoading: false, entryHits: [], entryTotal: 0, entrySearching: false, renames: {}, titles: {}, sessions: [], recoveredSubagents: [], dialogs: [], retrying: {}, pendingSteer: {}, widgets: {} });

    let storeEvents: (event: import('../src/shared/pi').PiEvent) => void = () => undefined;
    const backend = new PiBackend({ supported: true, executable: path.resolve('tests/fixtures/fake-pi.mjs'), agentDir: root, sessionDirs: [root], diagnostics: [] }, index, owned, path.resolve('extensions/desktop-policy/index.mjs'), event => {
      storeEvents(structuredClone(event));
    }, root);
    backends.push(backend);
    const factory = vi.fn((command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) => new PiRpcClient(command, args, cwd, env));
    backend.clientFactory = factory;

    const connect = await backend.connect({ sourceKey: fileKey(source), trustProject: false, permission: 'ask' });
    await backend.forkTo(connect.key, 'history-target-fork'); // C → T
    index.scan();
    const tip1 = connect.file.replace(/\.jsonl$/, '-tip.jsonl');
    const tip1Key = fileKey(tip1);

    // --- F-2 前置：往链尾 T 写入一条合法 single-async 子代理指针 + 子转录 + status ---
    const entry = (id: string, role: string, content: unknown, extra: Record<string, unknown> = {}) =>
      JSON.stringify({ type: 'message', id, timestamp: new Date().toISOString(), message: { role, content, ...extra } });
    const runId = 'post-fork-run', callId = 'post-fork-call';
    const asyncDir = path.join(subagentAsyncRoot(), runId);
    fs.mkdirSync(asyncDir, { recursive: true });
    const child = path.join(owned, 'child.jsonl');
    fs.writeFileSync(child, entry('child-answer', 'assistant', 'CHILD_TIP_ONLY') + '\n');
    fs.writeFileSync(path.join(asyncDir, 'status.json'), JSON.stringify({ mode: 'single', runId, sessionId: tip1, toolCallId: callId, state: 'running', startedAt: Date.now() - 2000, lastUpdate: Date.now(), steps: [{ agent: 'worker', sessionFile: child }] }));
    const details = { mode: 'single', runId, asyncDir, agent: 'worker', results: [] };
    const pointerLines = [entry('tip-context', 'user', 'NEW_TIP_CONTEXT'), entry('tip-call', 'assistant', [{ type: 'toolCall', id: callId, name: 'subagent', arguments: { agent: 'worker' } }]), entry('tip-result', 'toolResult', [], { toolCallId: callId, toolName: 'subagent', details })];
    fs.appendFileSync(tip1, pointerLines.map((line, i) => JSON.stringify({ ...JSON.parse(line), parentId: i === 0 ? 'latest-tip' : i === 1 ? 'tip-context' : 'tip-call' })).join('\n') + '\n');
    index.scan();

    // IPC handler 同款归一（src/main/index.ts: recoverSubagents/subagentChildTranscript
    // 都先过 backend.resolveHistoryKey）。runtime key C 与链尾 T 的查询结果必须一致。
    const recover = vi.fn((key: string, leaf?: string, pinned?: string[], knownSignature?: string) => recoverSubagents(root, backend.resolveHistoryKey(key), index, leaf, pinned, knownSignature));
    const transcript = vi.fn((key: string, call: string, childId: string) => subagentChildTranscript(root, backend.resolveHistoryKey(key), index, call, childId));
    const recoveredC = await recover(connect.key);
    const recoveredT = await recover(tip1Key);
    expect(JSON.stringify(recoveredC)).toBe(JSON.stringify(recoveredT));
    expect(JSON.stringify(recoveredC)).toContain(callId);
    const transcriptC = await transcript(connect.key, callId, 'single');
    const transcriptT = await transcript(tip1Key, callId, 'single');
    expect('error' in transcriptC).toBe(false);
    expect(transcriptC).toEqual(transcriptT);
    expect(JSON.stringify(transcriptC)).toContain('CHILD_TIP_ONLY');

    // --- 第二次 fork C → U，并在 U 上落一个专属哨兵条目 ---
    await backend.forkTo(connect.key, 'history-target-fork');
    index.scan();
    const tip2Key = backend.runs().find(r => r.key === connect.key)!.historyKey!;
    const tip2 = index.sessionsView(true).find(s => s.key === tip2Key)!.path;
    expect(tip2Key).not.toBe(tip1Key);
    fs.appendFileSync(tip2, JSON.stringify({ ...JSON.parse(entry('second-fork-tip', 'assistant', 'SECOND_FORK_TIP')), parentId: 'tip-result' }) + '\n');
    index.scan();

    // --- 完整 store 管线（init 装配 onEvent/closed 处理）+ 生产同构 api ---
    const historyCalls: string[] = [];
    const outlineCalls: string[] = [];
    const searchCalls: string[] = [];
    let outlineResolve: (value: { turns: unknown[] }) => void = () => undefined;
    let searchResolve: (value: { hits: unknown[]; total: number }) => void = () => undefined;
    const promptApi = vi.fn((key: string, text: string, behavior: 'steer' | 'followUp') => backend.prompt(key, text, behavior));
    const archive = new SessionArchive(path.join(root, 'archive.json'));
    const api = {
      settingsSnapshot: async () => ({ preferences: { projects: [], behavior: 'followUp' }, ai: {} }),
      environment: () => new Promise(() => undefined),
      sessions: async () => applyContinuations(index.sessionsView(), loadContinuations(root), usePiStore.getState().renames, s => s.key, 'unnamed'),
      runs: async () => structuredClone(backend.runs()),
      archivedSessions: async () => archive.list(),
      onEvent: (handler: (event: import('../src/shared/pi').PiEvent) => void) => { storeEvents = handler; },
      resolveSession: async (key: string) => backend.resolveSessionKey(key),
      history: async (key: string, leaf?: string, opts?: { tail?: number }) => { historyCalls.push(key); return structuredClone(index.history(key, leaf, opts)); },
      connect: async (input: Parameters<PiBackend['connect']>[0]) => backend.connect(input),
      prompt: promptApi,
      recoverSubagents: recover,
      subagentChildTranscript: transcript,
      saveDesktopSettings: async () => undefined,
      // src/main/index.ts setSessionArchived 同构：链端点归一 + 存在性过滤。
      setSessionArchived: async (key: string, value: boolean) => {
        const run = backend.runs().find(r => r.key === key);
        const self = index.sessionsView(true).find(s => s.key === key)?.path;
        const chain = self ? continuationChainKeys(self, loadContinuations(root)).filter(p => index.sessionsView(true).some(s => s.path === p)).map(fileKey) : [];
        const busy = !!run && (run.status !== 'idle' || (run.pending ?? 0) > 0 || backend.hasPendingDialogs(key));
        if (value && busy) throw new Error('任务仍在运行或等待确认，请先停止任务再归档。');
        return archive.setMany([...new Set([key, ...chain])], value);
      },
      sessionOutline: (key: string) => { outlineCalls.push(key); return new Promise(r => { outlineResolve = r; }); },
      searchSession: (key: string, query: string) => { searchCalls.push(key); void query; return new Promise(r => { searchResolve = r; }); },
    };
    vi.stubGlobal('window', { localPi: api });
    usePiStore.getState().init();
    usePiStore.setState({ sessions: await api.sessions(), env: { supported: true, diagnostics: [] } });

    // --- F-1 主路径前提：打开 source 解析到链尾，runtime 身份稳定 ---
    usePiStore.getState().selectSession(fileKey(source));
    await vi.waitFor(() => expect(usePiStore.getState().selectedKey).toBe(connect.key), { timeout: 5000 });
    await vi.waitFor(() => expect(usePiStore.getState().history?.branch.at(-1)?.id).toBe('second-fork-tip'), { timeout: 5000 });
    expect(currentRunOf(usePiStore.getState())?.generation).toBe(connect.generation);
    expect(historyCalls.length).toBeGreaterThan(0);
    expect(historyCalls.every(key => key === tip2Key)).toBe(true);
    expect(promptApi).not.toHaveBeenCalled();

    // --- F-4 ASYNC_ALIAS：outline/search 发起后 fork 换 historyKey，旧响应必须作废 ---
    usePiStore.setState({ outline: [], outlineLoading: false, entryHits: [], entrySearching: false });
    usePiStore.getState().setSessionMapOpen(true);
    usePiStore.getState().setSearchQuery('NEW_TIP');
    expect(outlineCalls).toEqual([tip2Key]);
    expect(searchCalls).toEqual([tip2Key]);
    await backend.forkTo(connect.key, 'history-target-fork'); // U → V（同一 runtime/generation）
    index.scan();
    const tip3Key = backend.runs().find(r => r.key === connect.key)!.historyKey!;
    const tip3 = index.sessionsView(true).find(s => s.key === tip3Key)!.path;
    expect(tip3Key).not.toBe(tip2Key);
    fs.appendFileSync(tip3, JSON.stringify({ ...JSON.parse(entry('third-fork-tip', 'assistant', 'THIRD_FORK_TIP')), parentId: 'second-fork-tip' }) + '\n');
    index.scan();
    promptApi.mockClear();
    outlineResolve({ turns: [{ entryId: 'STALE_U_OUTLINE' }] });
    searchResolve({ hits: [{ entryId: 'STALE_U_HIT' }], total: 1 });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(usePiStore.getState().outline).toEqual([]);
    expect(usePiStore.getState().entryHits).toEqual([]);
    // 守卫后 loading 状态自愈：重开拿到新代际（正向对照，证明不是全部丢弃）。
    usePiStore.getState().setSessionMapOpen(false);
    usePiStore.getState().setSessionMapOpen(true);
    expect(outlineCalls.at(-1)).toBe(tip3Key);
    outlineResolve({ turns: [{ entryId: 'FRESH_V_OUTLINE' }] });
    await vi.waitFor(() => expect((usePiStore.getState().outline[0] as { entryId?: string })?.entryId).toBe('FRESH_V_OUTLINE'), { timeout: 2000 });
    usePiStore.getState().setSearchQuery('NEW_TIP');
    searchResolve({ hits: [{ entryId: 'FRESH_V_HIT' }], total: 1 });
    await vi.waitFor(() => expect((usePiStore.getState().entryHits[0] as { entryId?: string })?.entryId).toBe('FRESH_V_HIT'), { timeout: 2000 });
    usePiStore.getState().setSearchQuery('');

    // --- F-3 SIDEBAR_METADATA：合并行 rename/archive 必须覆盖 runtime key + 链尾 ---
    const sessions = applyContinuations(index.sessionsView(), loadContinuations(root), usePiStore.getState().renames, s => s.key, 'unnamed');
    const sidebar = () => buildPiSidebar(applyContinuations(index.sessionsView(), loadContinuations(root), usePiStore.getState().renames, s => s.key, 'unnamed'), structuredClone(backend.runs()), [root], usePiStore.getState().renames, undefined, usePiStore.getState().archivedKeys);
    const row = sidebar().projects[0].sessions.find(s => s.id === connect.key)!;
    expect(row).toBeTruthy();
    expect(row.path).toBe(tip3);
    usePiStore.getState().renameSession(connect.key, 'RENAMED_AFTER_FORK');
    expect(usePiStore.getState().renames[connect.key]).toBe('RENAMED_AFTER_FORK');
    expect(usePiStore.getState().renames[tip3Key]).toBe('RENAMED_AFTER_FORK');
    expect(sidebar().projects[0].sessions.find(s => s.id === connect.key)?.title).toBe('RENAMED_AFTER_FORK');
    await usePiStore.getState().setSessionArchived(connect.key, true);
    expect(usePiStore.getState().archivedKeys).toEqual(expect.arrayContaining([connect.key, tip3Key]));
    const afterArchive = sidebar().projects[0].sessions;
    expect(afterArchive.some(s => s.id === connect.key || s.id === tip3Key || s.path === tip3)).toBe(false);
    // 归档选中的合并行会回 home（既有语义）；重新打开同一逻辑会话继续。
    usePiStore.getState().selectSession(connect.key);
    usePiStore.setState({ archivedKeys: [] }); // 后续 close 场景与归档无关，解除侧栏过滤
    await vi.waitFor(() => expect(usePiStore.getState().history?.branch.at(-1)?.id).toBe('third-fork-tip'), { timeout: 5000 });

    // --- F-1 CLOSE_ALIAS：run 关闭后仍读链尾、不发 prompt、runtime 身份不漂移 ---
    // 先把 history 置回旧 C 内容：关闭后只有 F-1 分支能把它刷回链尾，断言不虚。
    usePiStore.setState({ history: structuredClone(index.history(connect.key)) });
    expect(usePiStore.getState().history?.branch.at(-1)?.id).toBe('old-source');
    backend.close(connect.key);
    await vi.waitFor(() => expect(usePiStore.getState().history?.branch.at(-1)?.id).toBe('third-fork-tip'), { timeout: 5000 });
    expect(usePiStore.getState().selectedKey).toBe(connect.key);
    expect(usePiStore.getState().runs.some(r => r.key === connect.key)).toBe(false);
    expect(promptApi).not.toHaveBeenCalled();
    expect(historyCalls.at(-1)).toBe(tip3Key);
    // 关闭后重连：延续链解析把 sourceKey=runtime key 带回链尾文件（独立 runtime）。
    const reconnected = await backend.connect({ sourceKey: connect.key, trustProject: false, permission: 'ask' });
    expect(reconnected.key).toBe(tip3Key);
    backend.close(reconnected.key);

    // --- F-4 LATE_PREWARM：run 事件先到，迟到的 prewarm connect 快照不得覆盖 ---
    let resolveRace: ((run: PiRun) => void) | undefined;
    api.connect = () => new Promise(resolve => { resolveRace = resolve; });
    usePiStore.setState({ selectedKey: 'race-C', view: 'chat', runs: [], history: undefined });
    usePiStore.getState().prewarmSession('race-source');
    const latest = {
      key: 'race-C', generation: 'new-gen', file: path.join(root, 'unused.jsonl'), cwd: root, status: 'running', pending: 2,
      models: [], commands: [], historyKey: 'race-U', queue: [{ text: 'KEEP', behavior: 'followUp' }],
    } as unknown as PiRun;
    storeEvents({ type: 'run', run: latest });
    resolveRace!({
      key: 'race-C', generation: 'old-gen', file: path.join(root, 'unused.jsonl'), cwd: root, status: 'idle', pending: 0,
      models: [], commands: [], historyKey: 'race-T',
    } as unknown as PiRun);
    await new Promise(resolve => setTimeout(resolve, 30));
    const raced = usePiStore.getState().runs.find(r => r.key === 'race-C');
    expect(raced?.generation).toBe('new-gen');
    expect(raced?.status).toBe('running');
    expect(raced?.pending).toBe(2);
    expect(raced?.queue?.[0]?.text).toBe('KEEP');
    expect(factory).toHaveBeenCalledTimes(2); // C 一次 + 关闭后重连 V 一次；fork/预热复用同一 runtime
    // 收尾：让迟到刷新的重试链失活（selectedKey 已变，doRefreshHistory 守卫会拒绝）。
    usePiStore.setState({ selectedKey: null, view: 'home' });
  } finally {
    if (previousAsyncRoot === undefined) delete process.env.PI_SUBAGENTS_TEMP_ROOT;
    else process.env.PI_SUBAGENTS_TEMP_ROOT = previousAsyncRoot;
  }
}, 30000);
