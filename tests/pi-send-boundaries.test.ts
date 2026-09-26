import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { confirmSends, sentConversationMessages, usePiStore } from '../src/renderer/pi/adapter';
import { executionTurns } from '../src/renderer/replica/chat/execution';
import type { PiEntry, PiHistory, PiRun } from '../src/shared/pi';

const run: PiRun = { key: 'send-test', generation: 'send-generation', cwd: '/mock', file: '/mock/session', status: 'idle', models: [], commands: [], pending: 0 };
const entry = (id: string, role: string, content: unknown): PiEntry => ({ id, type: 'message', message: { role, content } } as PiEntry);
const history = (branch: PiEntry[]) => ({ branch } as PiHistory);
const deferred = <T = void>() => { let resolve!: (v: T) => void; let reject!: (e: Error) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
let emit: (e: any) => void;
let api: any;
const rpc = (event: any) => emit({ type: 'rpc', key: run.key, generation: run.generation, event });
const messages = () => { const s = usePiStore.getState(); return sentConversationMessages(s.history?.branch ?? [], s.live[run.key], s.toolProgress[run.key], s.sends ?? []); };

beforeAll(() => {
  vi.useFakeTimers();
  api = { settingsSnapshot: vi.fn().mockRejectedValue('mock'), environment: vi.fn().mockRejectedValue('mock'), sessions: vi.fn().mockResolvedValue([]), runs: vi.fn().mockResolvedValue([]), archivedSessions: vi.fn().mockResolvedValue([]), onEvent: (fn: typeof emit) => { emit = fn; }, prompt: vi.fn(), history: vi.fn() };
  vi.stubGlobal('window', { localPi: api });
  usePiStore.getState().init();
});
beforeEach(async () => {
  await vi.advanceTimersByTimeAsync(500);
  api.prompt.mockReset(); api.history.mockReset();
  api.history.mockRejectedValue(new Error('history unavailable'));
  usePiStore.setState({ selectedKey: run.key, runs: [run], history: history([entry('old-user', 'user', 'old')]), sends: [], pendingPrompt: undefined, pendingPromptAt: undefined, sentAt: undefined, pendingSteer: {}, live: {}, toolProgress: {}, contextItems: [], draftText: '', connecting: false, changingAccessMode: false, error: undefined });
});
afterAll(async () => { await vi.advanceTimersByTimeAsync(500); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('keeps the new user last through two slow IPC rounds, preserves old tools, and acknowledges atomically', async () => {
  const old = [entry('old-user', 'user', 'old')];
  // Old unpersisted progress has no timestamp. It must not become new work.
  rpc({ type: 'tool_execution_start', toolCallId: 'old-tool', toolName: 'read', args: { path: 'old' } });
  for (let round = 1; round <= 2; round++) {
    const prompt = deferred(); const disk = deferred<PiHistory>();
    api.prompt.mockReturnValueOnce(prompt.promise); api.history.mockReturnValueOnce(disk.promise);
    usePiStore.getState().send(`round-${round}`);
    const id = usePiStore.getState().sends!.at(-1)!.id;
    expect(messages().at(-1)?.id).toBe(id);
    expect(messages().slice(0, -1).some(m => m.parts.some(p => p.kind === 'tool' && p.callId === 'old-tool'))).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(messages().at(-1)?.id).toBe(id);
    rpc({ type: 'agent_start' });
    await vi.advanceTimersByTimeAsync(400);
    expect(messages().at(-1)?.id).toBe(id);
    old.push(entry(`u${round}`, 'user', `round-${round}`));
    const counts: number[] = [];
    const unsubscribe = usePiStore.subscribe(() => counts.push(messages().filter(m => m.role === 'user').length));
    disk.resolve(history([...old])); await vi.advanceTimersByTimeAsync(0); unsubscribe();
    expect(counts.every(n => n === round + 1)).toBe(true);
    expect(messages().at(-1)?.id).toBe(id);
    rpc({ type: 'tool_execution_end', toolCallId: 'old-tool', toolName: 'read', result: { content: 'late old result' } });
    expect(messages().at(-1)?.id).toBe(id);
    expect(messages().slice(0, -1).some(m => m.parts.some(p => p.kind === 'tool' && p.callId === 'old-tool'))).toBe(true);
    expect(usePiStore.getState().sends!.at(-1)?.confirmedId).toBe(`u${round}`);
    rpc({ type: 'tool_execution_start', toolCallId: `tool-${round}`, toolName: 'bash', args: {} });
    await vi.advanceTimersByTimeAsync(150);
    expect(messages().at(-1)?.parts.some(p => p.kind === 'tool' && p.callId === `tool-${round}`)).toBe(true);
    prompt.resolve(); await vi.advanceTimersByTimeAsync(500);
  }
});

it('keeps late anonymous deltas and a final summary in their original turn after agent_start', async () => {
  rpc({ type: 'message_start', message: { role: 'assistant', timestamp: 100, content: [] } });
  rpc({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'OLD' } });
  await vi.advanceTimersByTimeAsync(150);
  api.prompt.mockReturnValue(deferred().promise);
  usePiStore.getState().send('next');
  const id = usePiStore.getState().sends!.at(-1)!.id;
  rpc({ type: 'agent_start' });
  rpc({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: ' SUMMARY' } });
  await vi.advanceTimersByTimeAsync(150);
  expect(messages().at(-1)?.id).toBe(id);
  rpc({ type: 'message_end', message: { role: 'assistant', timestamp: 100, content: [{ type: 'text', text: 'OLD SUMMARY' }] } });
  expect(messages().at(-1)?.id).toBe(id);
  expect(JSON.stringify(messages()).match(/OLD SUMMARY/g)).toHaveLength(1);
  rpc({ type: 'message_start', message: { role: 'assistant', timestamp: 200, content: [] } });
  rpc({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'NEW' } });
  await vi.advanceTimersByTimeAsync(150);
  expect(messages().at(-1)?.parts[0]).toMatchObject({ text: 'NEW' });
});

it('does not erase a newer stream when an identified old end arrives', async () => {
  rpc({ type: 'message_start', message: { role: 'assistant', timestamp: 50, content: [] } });
  rpc({ type: 'message_update', message: { role: 'assistant', timestamp: 50, content: 'old' } });
  await vi.advanceTimersByTimeAsync(150);
  api.prompt.mockReturnValue(deferred().promise);
  usePiStore.getState().send('new user'); rpc({ type: 'agent_start' });
  rpc({ type: 'message_start', message: { role: 'assistant', timestamp: 60, content: [] } });
  rpc({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'new output' } });
  rpc({ type: 'message_end', message: { role: 'assistant', timestamp: 50, content: 'old final' } });
  expect(messages().at(-1)?.parts[0]).toMatchObject({ text: 'new output' });
  expect(messages().findIndex(m => m.parts.some(p => p.kind === 'text' && p.text === 'old final'))).toBeLessThan(messages().findIndex(m => m.role === 'user' && m.parts.some(p => p.kind === 'text' && p.text === 'new user')));
});

it('snapshots RPC objects and hands three rounds to slow history without duplicates or old work moving', async () => {
  const branch = [entry('old-user', 'user', 'old')];
  for (let n = 1; n <= 3; n++) {
    const timestamp = n * 1000;
    const message = { role: 'assistant', timestamp, content: [{ type: 'text', text: `summary-${n}` }] };
    rpc({ type: 'message_start', message });
    rpc({ type: 'message_update', message });
    rpc({ type: 'tool_execution_start', toolCallId: `summary-tool-${n}`, toolName: 'read', args: {} });
    rpc({ type: 'tool_execution_end', toolCallId: `summary-tool-${n}`, toolName: 'read', result: { content: 'retained process' } });
    await vi.advanceTimersByTimeAsync(150);
    const snapshot = JSON.stringify(usePiStore.getState().live);
    message.content[0].text = 'MUTATED';
    expect(JSON.stringify(usePiStore.getState().live)).toBe(snapshot);
    message.content[0].text = `summary-${n}`;
    api.prompt.mockReturnValueOnce(deferred().promise);
    const disk = deferred<PiHistory>(); api.history.mockReturnValueOnce(disk.promise);
    usePiStore.getState().send(`next-${n}`);
    const id = usePiStore.getState().sends!.at(-1)!.id;
    rpc({ type: 'agent_start' });
    await vi.advanceTimersByTimeAsync(400);
    // The new user is on disk while the old final summary is not yet saved.
    branch.push(entry(`user-${n}`, 'user', `next-${n}`));
    disk.resolve(history([...branch])); await vi.advanceTimersByTimeAsync(0);
    rpc({ type: 'message_end', message });
    expect(messages().at(-1)?.id).toBe(id);
    expect(JSON.stringify(messages()).match(new RegExp(`summary-${n}`, 'g'))).toHaveLength(1);
    branch.splice(branch.length - 1, 0, { id: `answer-${n}`, type: 'message', message } as PiEntry);
    api.history.mockResolvedValue(history([...branch]));
    await vi.advanceTimersByTimeAsync(400);
    expect(messages().at(-1)?.id).toBe(id);
    expect(JSON.stringify(messages()).match(new RegExp(`summary-${n}`, 'g'))).toHaveLength(1);
    expect(messages().filter(m => m.role === 'user')).toHaveLength(n + 1);
    const turn = executionTurns(messages()).at(-2)!;
    expect(turn.answer).toContainEqual(expect.objectContaining({ kind: 'text', text: `summary-${n}` }));
    expect(turn.steps).toContainEqual(expect.objectContaining({ kind: 'tool', callId: `summary-tool-${n}` }));
  }
});

it('routes an identified late delta to the old message after a new stream starts', async () => {
  rpc({ type: 'message_start', message: { role: 'assistant', timestamp: 701, model: 'keep-model', content: [] } });
  rpc({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'OLD' } });
  api.prompt.mockReturnValue(deferred().promise);
  usePiStore.getState().send('boundary'); rpc({ type: 'agent_start' });
  rpc({ type: 'message_start', message: { role: 'assistant', timestamp: 702, content: [] } });
  rpc({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'NEW' } });
  rpc({ type: 'message_update', message: { role: 'assistant', timestamp: 701 }, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: ' LATE' } });
  await vi.advanceTimersByTimeAsync(150);
  expect(usePiStore.getState().live[run.key]['701']).toMatchObject({ timestamp: 701, model: 'keep-model', content: [{ text: 'OLD LATE' }] });
  expect(usePiStore.getState().live[run.key]['702'].content).toEqual([{ type: 'text', text: 'NEW' }]);
  expect(messages().at(-1)?.parts[0]).toMatchObject({ text: 'NEW' });
  rpc({ type: 'message_update', message: { role: 'assistant', timestamp: 701, content: [{ type: 'text', text: 'OLD SNAPSHOT' }] } });
  rpc({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: ' CONTINUED' } });
  await vi.advanceTimersByTimeAsync(150);
  expect(messages().at(-1)?.parts[0]).toMatchObject({ text: 'NEW CONTINUED' });
  expect(usePiStore.getState().live[run.key]['701'].content).toEqual([{ type: 'text', text: 'OLD SNAPSHOT' }]);
});

it('uses full message+delta snapshots once and retains start metadata on later deltas', async () => {
  rpc({ type: 'message_start', message: { role: 'assistant', timestamp: 703, model: 'model', content: [] } });
  rpc({ type: 'message_update', message: { role: 'assistant', timestamp: 703, content: [{ type: 'text', text: 'complete' }] }, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'plete' } });
  rpc({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: ' next' } });
  await vi.advanceTimersByTimeAsync(150);
  expect(usePiStore.getState().live[run.key]['703']).toMatchObject({ timestamp: 703, model: 'model', content: [{ text: 'complete next' }] });
});

it.each(['followUp', 'steer'] as const)('keeps orphan tools before a queued %s user without an optimistic send', async behavior => {
  rpc({ type: 'tool_execution_start', toolCallId: 'queued-old', toolName: 'read', args: {} });
  usePiStore.setState({ runs: [{ ...run, status: 'running' }], behavior });
  api.prompt.mockReturnValue(deferred().promise);
  usePiStore.getState().send('queued');
  expect(usePiStore.getState().sends).toEqual([]);
  expect(api.prompt).toHaveBeenCalledWith(run.key, 'queued', behavior);
  usePiStore.setState({ history: history([entry('old-user', 'user', 'old'), entry('queued-user', 'user', 'queued')]) });
  rpc({ type: 'tool_execution_end', toolCallId: 'queued-old', toolName: 'read', result: { content: 'old orphan' } });
  expect(messages().at(-1)?.id).toBe('queued-user');
  expect(JSON.stringify(messages())).toContain('old orphan');
});

it('isolates transient work when its confirmed boundary disappears without dropping branch history', () => {
  const sends = [{ id: 'gone-send', key: run.key, at: 1, text: 'gone', images: [], baseline: [], confirmedId: 'gone-user' }];
  const result = sentConversationMessages([entry('other', 'user', 'other branch')], { '800': { role: 'assistant', _turnId: 'gone-send', content: 'foreign live' } }, [{ toolCallId: 'foreign', turnId: 'gone-send', name: 'read', text: 'foreign tool', status: 'done' }], sends);
  expect(result.map(m => m.id)).toEqual(['other']);
  expect(JSON.stringify(result)).toContain('other branch');
  const restored = sentConversationMessages([entry('gone-user', 'user', 'gone')], { '800': { role: 'assistant', _turnId: 'gone-send', content: 'foreign live' } }, [{ toolCallId: 'foreign', turnId: 'gone-send', name: 'read', text: 'foreign tool', status: 'done' }], sends);
  expect(JSON.stringify(restored)).toContain('foreign live');
  expect(JSON.stringify(restored)).toContain('foreign tool');
});

it('renders an image-only send immediately and matches the image, not just fallback text', async () => {
  const image = { type: 'image' as const, mimeType: 'image/png', data: 'aGVsbG8=' };
  const context = { id: 'image', name: 'pic.png', path: '', kind: 'image' as const, text: '', image };
  const prompt = deferred(); api.prompt.mockReturnValue(prompt.promise);
  usePiStore.setState({ contextItems: [context] }); usePiStore.getState().send('');
  expect(messages().at(-1)?.parts).toContainEqual(expect.objectContaining({ kind: 'image', data: image.data }));
  const sends = usePiStore.getState().sends!;
  const text = sends[0].text;
  expect(confirmSends(sends, history([entry('wrong', 'user', text)]), run.key)[0].confirmedId).toBeUndefined();
  expect(confirmSends(sends, history([entry('right', 'user', [{ type: 'text', text }, image])]), run.key)[0].confirmedId).toBe('right');
  prompt.reject(new Error('offline')); await vi.advanceTimersByTimeAsync(0);
  expect(usePiStore.getState()).toMatchObject({ sends: [], sentAt: undefined, pendingPrompt: undefined, contextItems: [context], draftText: '' });
});

it('routes a late old-tool update by persisted call identity even after progress retirement', () => {
  const branch = [entry('old', 'assistant', [{ type: 'toolCall', id: 'old-call', name: 'read', arguments: {} }]), entry('new', 'user', 'next')];
  const sends = [{ id: 'send-next', key: run.key, at: 1, text: 'next', images: [], baseline: ['old'], confirmedId: 'new' }];
  const tools = [{ toolCallId: 'old-call', turnId: 'send-next', name: 'read', text: 'late', status: 'done' as const }];
  const projected = sentConversationMessages(branch, {}, tools, sends);
  expect(projected.at(-1)?.id).toBe('send-next');
  expect(projected[0].parts.some(p => p.kind === 'tool' && p.callId === 'old-call' && p.status === 'done')).toBe(true);
  branch.splice(1, 0, { ...entry('result', 'toolResult', 'saved'), message: { role: 'toolResult', toolCallId: 'old-call', content: 'saved' } });
  const saved = sentConversationMessages(branch, {}, tools, sends);
  expect(saved.at(-1)?.id).toBe('send-next');
  expect(JSON.stringify(saved)).not.toContain('late');
});

it('does not match a same-text baseline entry or claim one entry twice', () => {
  const send = { id: 's1', key: run.key, at: 1, text: 'same', images: [], baseline: ['baseline'] };
  const result = confirmSends([send, { ...send, id: 's2' }], history([entry('baseline', 'user', 'same'), entry('new', 'user', 'same')]), run.key);
  expect(result.map(s => s.confirmedId)).toEqual(['new', undefined]);
});

it.each(['draft', 'session'])('late failure preserves a newer %s', async mode => {
  const prompt = deferred(); api.prompt.mockReturnValue(prompt.promise);
  usePiStore.getState().send('failed');
  usePiStore.setState({ draftText: 'keep', ...(mode === 'session' ? { selectedKey: 'elsewhere' } : {}) });
  prompt.reject(new Error('offline')); await vi.advanceTimersByTimeAsync(0);
  expect(usePiStore.getState().draftText).toBe('keep'); expect(usePiStore.getState().sends).toEqual([]);
});

it('does not roll back a user already confirmed on disk after a late IPC rejection', async () => {
  const prompt = deferred(); api.prompt.mockReturnValue(prompt.promise);
  usePiStore.getState().send('saved');
  api.history.mockResolvedValue(history([entry('saved-id', 'user', 'saved')]));
  rpc({ type: 'agent_start' }); await vi.advanceTimersByTimeAsync(400);
  prompt.reject(new Error('late failure')); await vi.advanceTimersByTimeAsync(0);
  expect(usePiStore.getState().sends?.[0].confirmedId).toBe('saved-id');
  expect(usePiStore.getState().draftText).toBe('');
});

it('serializes slow history reads and re-reads after an in-flight pre-send snapshot', async () => {
  const stale = deferred<PiHistory>(); const fresh = deferred<PiHistory>();
  api.history.mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise);
  usePiStore.getState().selectSession(run.key);
  await vi.advanceTimersByTimeAsync(400);
  api.prompt.mockResolvedValue(undefined);
  usePiStore.getState().send('after snapshot');
  await vi.advanceTimersByTimeAsync(1500);
  expect(api.history).toHaveBeenCalledTimes(1);
  stale.resolve(history([])); await vi.advanceTimersByTimeAsync(400);
  expect(api.history).toHaveBeenCalledTimes(2);
  expect(messages().at(-1)?.parts[0]).toMatchObject({ text: 'after snapshot' });
  fresh.resolve(history([entry('fresh', 'user', 'after snapshot')])); await vi.advanceTimersByTimeAsync(0);
  expect(usePiStore.getState().sends?.[0].confirmedId).toBe('fresh');
  expect(messages()).toHaveLength(1);
});

it('rolls back only its own optimistic queue item on failure', async () => {
  const prompt = deferred(); api.prompt.mockReturnValue(prompt.promise);
  const prior = { text: 'prior', behavior: 'followUp' as const };
  usePiStore.setState({ runs: [{ ...run, status: 'running', queue: [prior], pending: 1 }] });
  usePiStore.getState().send('failed');
  expect(usePiStore.getState().runs[0].queue).toHaveLength(2);
  prompt.reject(new Error('queue rejected')); await vi.advanceTimersByTimeAsync(0);
  expect(usePiStore.getState().runs[0].queue).toEqual([prior]);
  expect(usePiStore.getState().runs[0].pending).toBe(1);
});
