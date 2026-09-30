// Incident regressions: synthetic IPC only, no provider, sessions or config access.
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { confirmSends, isAwaitingSend, sentConversationMessages, usePiStore } from '../src/renderer/pi/adapter';
import { ChatView } from '../src/renderer/replica/chat/ChatView';
import { replicaLabels } from '../src/renderer/replica/i18n';
import type { PiEntry, PiHistory, PiRun } from '../src/shared/pi';

let emit: (event: any) => void;
let api: any;
let run: PiRun;
let serial = 0;
const user = (id: string, text: string): PiEntry => ({ id, type: 'message', timestamp: '2026-09-27T07:07:59.254Z', message: { role: 'user', content: text } });
const history = (branch: PiEntry[]) => ({ branch } as PiHistory);
const rpc = (event: any) => emit({ type: 'rpc', key: run.key, generation: run.generation, event });
const messages = () => {
  const s = usePiStore.getState();
  return sentConversationMessages(s.history?.branch ?? [], s.live[run.key], s.toolProgress[run.key], s.sends.filter(x => x.key === run.key));
};
const html = () => renderToStaticMarkup(createElement(ChatView, {
  messages: messages(), running: true, queued: 1, demo: true,
  labels: replicaLabels('zh').chat, onRefreshProcess: usePiStore.getState().refreshConversation,
}));
const refresh = async (branch: PiEntry[]) => {
  api.history.mockResolvedValue(history(branch));
  const result = usePiStore.getState().refreshConversation();
  await vi.advanceTimersByTimeAsync(500);
  expect(await result).toBe(true);
};

beforeAll(async () => {
  vi.useFakeTimers();
  api = {
    settingsSnapshot: vi.fn().mockRejectedValue('mock'), environment: vi.fn().mockRejectedValue('mock'),
    sessions: vi.fn().mockResolvedValue([]), runs: vi.fn().mockResolvedValue([]), archivedSessions: vi.fn().mockResolvedValue([]),
    onEvent: (fn: typeof emit) => { emit = fn; }, history: vi.fn(), prompt: vi.fn(() => new Promise(() => {})),
  };
  vi.stubGlobal('window', { localPi: api });
  usePiStore.getState().init();
  await vi.advanceTimersByTimeAsync(0);
});
beforeEach(() => {
  run = { key: `diagnosis-${++serial}`, generation: `generation-${serial}`, cwd: '/synthetic', status: 'running', models: [], commands: [], pending: 1, queue: [{ text: 'another queued item', behavior: 'followUp' }] };
  api.history.mockReset();
  api.history.mockResolvedValue(history([user(`old-${serial}`, 'old')]));
  usePiStore.setState({ selectedKey: run.key, runs: [run], history: history([user(`old-${serial}`, 'old')]), sends: [], live: {}, toolProgress: {}, retrying: {}, contextItems: [], connecting: false, changingAccessMode: false, pendingSteer: {}, draftText: '' });
});
afterAll(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it.each([false, true])('anchors consumed queued-user streams before history catches up (old send confirmed=%s)', async confirmed => {
  const old = user(`old-${serial}`, 'old');
  const next = user(`new-${serial}`, 'consumed queued question');
  if (confirmed) usePiStore.setState({ sends: [{ id: `old-send-${serial}`, key: run.key, at: 1, text: 'old', images: [], baseline: [], confirmedId: old.id }] });
  // Runtime has consumed a queue item; renderer's disk history is still stale.
  rpc({ type: 'agent_start' });
  rpc({ type: 'message_start', message: { role: 'user', content: 'consumed queued question' } });
  rpc({ type: 'message_start', message: { role: 'assistant', timestamp: 1790492879269, content: [] } });
  rpc({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'synthetic visible thinking' } });
  await refresh([old, next]);
  expect(JSON.stringify(messages())).toContain('synthetic visible thinking');
  expect(messages().findIndex(m => m.id === next.id)).toBeLessThan(messages().findIndex(m => JSON.stringify(m).includes('synthetic visible thinking')));
  expect(html()).not.toContain('pi-waiting-process');
  // Ongoing deltas retain the consumed boundary through identity reconciliation.
  rpc({ type: 'message_update', message: { role: 'assistant', timestamp: '1790492879269' }, assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: ' continues' } });
  await refresh([old, next]);
  expect(Object.keys(usePiStore.getState().live[run.key])).toEqual(['1790492879269']);
  expect(JSON.stringify(messages())).toContain('synthetic visible thinking continues');
  expect(messages().at(-1)?.parts[0]).toMatchObject({ kind: 'thinking', text: 'synthetic visible thinking continues' });
  expect(html()).not.toContain('pi-waiting-process');
  // Persistence replaces the live copy without changing its turn.
  await refresh([old, next, { id: `saved-${serial}`, type: 'message', timestamp: '2026-09-27T07:11:25.264Z', message: { role: 'assistant', timestamp: 1790492879269, stopReason: 'toolUse', content: [{ type: 'thinking', thinking: 'synthetic visible thinking continues' }] } }]);
  expect(messages().at(-1)?.id).toBe(`saved-${serial}`);
  expect(html()).not.toContain('pi-waiting-process');
});

it('an authoritative empty queue run clears consumed pendingSync while running', () => {
  usePiStore.setState({ runs: [{ ...run, queue: [{ text: 'already consumed', behavior: 'followUp', pendingSync: true }], pending: 1 }] });
  rpc({ type: 'queue_update', steering: [], followUp: [] });
  emit({ type: 'run', run: { ...run, queue: [], pending: 0 } });
  expect(usePiStore.getState().runs[0].pending).toBe(0);
  expect(usePiStore.getState().runs[0].queue).toEqual([]);
});

it.each([{ authoritative: [] }, { authoritative: [{ text: 'same', behavior: 'followUp' as const, images: [{ type: 'image' as const, mimeType: 'image/png', data: 'SECOND' }] }] }])('preserves newer local queue sends across an older authoritative snapshot (%j)', async ({ authoritative }) => {
  const old = { text: 'same', behavior: 'followUp' as const, pendingSync: true, images: [{ type: 'image' as const, mimeType: 'image/png', data: 'FIRST' }] };
  usePiStore.setState({ runs: [{ ...run, queue: [old], pending: 1 }], behavior: 'followUp' });
  rpc({ type: 'queue_update', steering: [], followUp: authoritative.map(q => q.text) });
  // Renderer action interleaves between the two IPC deliveries; identical text
  // must not acknowledge/remove this newer send or borrow the older image.
  const image = { type: 'image' as const, mimeType: 'image/png', data: 'NEWER' };
  usePiStore.setState({ contextItems: [{ id: 'new-image', kind: 'image', name: 'synthetic.png', path: '', text: '', image }] });
  usePiStore.getState().send('same');
  const newer = usePiStore.getState().runs[0].queue!.at(-1)!;
  emit({ type: 'run', run: { ...run, queue: authoritative, pending: authoritative.length } });
  expect(usePiStore.getState().runs[0].queue).toEqual([...authoritative, newer]);
  expect(usePiStore.getState().runs[0].queue!.at(-1)).toBe(newer);
  expect(usePiStore.getState().runs[0].pending).toBe(authoritative.length + 1);
  // Ordinary empty views must not resurrect the already acknowledged old item.
  if (!authoritative.length) {
    emit({ type: 'run', run: { ...run, queue: [], pending: 0 } });
    expect(usePiStore.getState().runs[0].queue).toEqual([newer]);
  }
});

it('keeps a local send made before an older queue event until the host prompt echo observes it', () => {
  const old = { text: 'same', behavior: 'followUp' as const, pendingSync: true };
  usePiStore.setState({ runs: [{ ...run, queue: [old], pending: 1 }], behavior: 'followUp' });
  usePiStore.getState().send('same');
  const newer = usePiStore.getState().runs[0].queue!.at(-1)!;
  // A queued event can already be in flight when the renderer calls prompt.
  rpc({ type: 'queue_update', steering: [], followUp: [] });
  emit({ type: 'run', run: { ...run, queue: [], pending: 0 } });
  expect(usePiStore.getState().runs[0].queue).toEqual([newer]);
  // The host's prompt echo now observes that exact remaining occurrence.
  emit({ type: 'run', run: { ...run, queue: [{ text: 'same', behavior: 'followUp', pendingSync: true }], pending: 1 } });
  rpc({ type: 'queue_update', steering: [], followUp: [] });
  emit({ type: 'run', run: { ...run, queue: [], pending: 0 } });
  expect(usePiStore.getState().runs[0].queue).toEqual([]);
});

it('does not drop a second identical local send when only the first host echo arrives', () => {
  usePiStore.setState({ runs: [{ ...run, queue: [], pending: 0 }], behavior: 'followUp' });
  usePiStore.getState().send('same');
  usePiStore.getState().send('same');
  const second = usePiStore.getState().runs[0].queue![1];
  const echo = { text: 'same', behavior: 'followUp' as const, pendingSync: true };
  emit({ type: 'run', run: { ...run, queue: [echo], pending: 1 } });
  expect(usePiStore.getState().runs[0].queue).toEqual([echo, second]);
  rpc({ type: 'queue_update', steering: [], followUp: [] });
  emit({ type: 'run', run: { ...run, queue: [], pending: 0 } });
  expect(usePiStore.getState().runs[0].queue).toEqual([second]);
});

it('preserves a pendingSync edit after the queue watermark without reviving untouched consumed peers', () => {
  const first = { text: 'first', behavior: 'followUp' as const, pendingSync: true };
  const second = { text: 'second', behavior: 'followUp' as const, pendingSync: true };
  usePiStore.setState({ runs: [{ ...run, queue: [first, second], pending: 2 }] });
  api.queueEdit = vi.fn(() => new Promise(() => {}));
  rpc({ type: 'queue_update', steering: [], followUp: [] });
  usePiStore.getState().queueEdit({ type: 'edit', index: 1, text: 'newer edited input' });
  emit({ type: 'run', run: { ...run, queue: [], pending: 0 } });
  expect(usePiStore.getState().runs[0].queue).toEqual([{ ...second, text: 'newer edited input' }]);
});

it('never carries pending queue entries across a new backend generation', () => {
  usePiStore.setState({ runs: [{ ...run, queue: [{ text: 'old generation', behavior: 'followUp', pendingSync: true }], pending: 1 }] });
  rpc({ type: 'queue_update', steering: [], followUp: [] });
  emit({ type: 'run', run: { ...run, generation: 'replacement', queue: [], pending: 0 } });
  expect(usePiStore.getState().runs[0].queue).toEqual([]);
});

it('consumes only one of an identical queue pair and keeps authoritative image identity', () => {
  const image = (data: string) => ({ type: 'image' as const, mimeType: 'image/png', data });
  const first = { text: 'same', behavior: 'followUp' as const, pendingSync: true, images: [image('FIRST')] };
  const second = { ...first, images: [image('SECOND')] };
  usePiStore.setState({ runs: [{ ...run, queue: [first, second], pending: 2 }] });
  rpc({ type: 'queue_update', steering: [], followUp: ['same'] });
  emit({ type: 'run', run: { ...run, queue: [{ ...second, pendingSync: undefined }], pending: 1 } });
  expect(usePiStore.getState().runs[0].queue).toEqual([{ ...second, pendingSync: undefined }]);
  rpc({ type: 'queue_update', steering: [], followUp: [] });
  emit({ type: 'run', run: { ...run, queue: [], pending: 0 } });
  expect(usePiStore.getState().runs[0].queue).toEqual([]);
});

it('queue=1 does not suppress direct-send streaming, confirmed identity or numeric/string snapshot IDs', async () => {
  usePiStore.setState({ runs: [{ ...run, status: 'idle', pending: 0, queue: [] }] });
  usePiStore.getState().send('direct question');
  rpc({ type: 'agent_start' });
  rpc({ type: 'message_start', message: { role: 'assistant', timestamp: 1790492879269, content: [] } });
  rpc({ type: 'message_update', message: { role: 'assistant', timestamp: '1790492879269', content: [{ type: 'thinking', thinking: 'full snapshot' }] }, assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'snapshot' } });
  await refresh([user(`old-${serial}`, 'old'), user(`new-${serial}`, 'direct question')]);
  usePiStore.setState({ runs: [run] });
  rpc({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: ' plus delta' } });
  await vi.advanceTimersByTimeAsync(150);
  expect(usePiStore.getState().sends[0].confirmedId).toBe(`new-${serial}`);
  expect(messages().at(-1)?.parts[0]).toMatchObject({ kind: 'thinking', text: 'full snapshot plus delta' });
  expect(html()).not.toContain('pi-waiting-process');
});

it('received user + agent_settled + failed history does not keep an idle task sending', async () => {
  usePiStore.setState({ runs: [{ ...run, pending: 0, queue: [] }] });
  api.history.mockRejectedValue(new Error('disk unavailable'));
  rpc({ type: 'message_start', message: { role: 'user', timestamp: 100, content: 'consumed' } });
  const boundary = usePiStore.getState().sends[0];
  rpc({ type: 'agent_settled' });
  await vi.advanceTimersByTimeAsync(500);
  const state = usePiStore.getState();
  expect(state.runs[0].status).toBe('idle');
  expect(state.sends).toEqual([boundary]);
  expect(state.sends.some(isAwaitingSend)).toBe(false);
  expect(messages().at(-1)?.parts[0]).toMatchObject({ text: 'consumed' });
  const rendered = renderToStaticMarkup(createElement(ChatView, {
    messages: messages(), sending: state.sends.some(isAwaitingSend), running: state.runs[0].status === 'running',
    labels: replicaLabels('zh').chat, demo: true,
  }));
  expect(rendered).not.toContain('pi-chat__working');
  usePiStore.getState().send('real local send');
  expect(usePiStore.getState().sends.at(-1)).toMatchObject({ text: 'real local send' });
  expect(usePiStore.getState().sends.some(isAwaitingSend)).toBe(true);
});

it('successful settlement retains received boundaries even with promptDone while retiring local orphans', async () => {
  usePiStore.setState({ runs: [{ ...run, pending: 0, queue: [] }] });
  rpc({ type: 'message_start', message: { role: 'user', content: 'not saved yet' } });
  const boundary = { ...usePiStore.getState().sends[0], promptDone: true };
  usePiStore.setState({ sends: [boundary, { ...boundary, id: 'orphan', received: false }] });
  rpc({ type: 'agent_settled' });
  await vi.advanceTimersByTimeAsync(500);
  expect(usePiStore.getState().sends).toEqual([boundary]);
});

it('confirms within the session and retains runtime ID rather than a colliding timestamp', () => {
  const send = { id: 'received', key: run.key, received: true, at: 1, text: 'same', images: [], baseline: [], messageIdentity: 'runtime-new' };
  const saved = (id: string, runtimeId: string): PiEntry => ({ ...user(id, 'same'), message: { role: 'user', id: runtimeId, timestamp: 1, content: 'same' } });
  const sends = confirmSends([{ ...send, key: 'elsewhere', confirmedId: 'right' }, send], history([saved('wrong', 'runtime-old'), saved('right', 'runtime-new')]), run.key);
  expect(sends[1].confirmedId).toBe('right');
  expect(sends[1].messageIdentity).toBe('runtime-new');
  const local = { id: 'local', key: run.key, at: 1, text: 'same', images: [], baseline: [] };
  expect(confirmSends([local], history([saved('right', 'runtime-new')]), run.key)[0].messageIdentity).toBe('runtime-new');
});

it('background ownership survives confirmation and late old user events without selected history', async () => {
  const first = { ...user('first', 'same'), message: { role: 'user', timestamp: 101, content: 'same' } };
  const second = { ...user('second', 'same'), message: { role: 'user', timestamp: 102, content: 'same' } };
  for (const entry of [first, second]) {
    rpc({ type: 'message_start', message: entry.message });
    rpc({ type: 'message_start', message: { role: 'assistant', timestamp: Number(entry.message!.timestamp) + 100, content: 'answer' } });
  }
  await refresh([first, second]);
  const newestOwner = usePiStore.getState().sends[1].id;
  usePiStore.setState({ selectedKey: 'elsewhere', history: undefined });
  rpc({ type: 'message_start', message: first.message });
  rpc({ type: 'agent_start' });
  rpc({ type: 'message_start', message: { role: 'assistant', timestamp: 203, content: 'new output' } });
  rpc({ type: 'message_update', message: { role: 'assistant', timestamp: 201 }, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: ' late old' } });
  await vi.advanceTimersByTimeAsync(150);
  const state = usePiStore.getState();
  expect(state.sends).toHaveLength(2);
  expect(state.live[run.key]['203']._turnId).toBe(newestOwner);
  expect(state.live[run.key]['201']._turnId).toBe(state.sends[0].id);
});

it('keeps a history-only turn owner after switching away before assistant output', async () => {
  rpc({ type: 'agent_start' });
  usePiStore.setState({ selectedKey: 'elsewhere', history: undefined });
  rpc({ type: 'message_start', message: { role: 'assistant', timestamp: 280, content: 'history owner output' } });
  await vi.advanceTimersByTimeAsync(150);
  expect(usePiStore.getState().live[run.key]['280']._turnId).toBe(`history:old-${serial}`);
});

it('a hidden session retains known baselines and owns output even before agent_start', async () => {
  usePiStore.setState({ selectedKey: 'elsewhere', history: undefined, sends: [{
    id: 'background-local', key: run.key, at: 1, text: 'first', images: [], baseline: ['older-same'], confirmedId: 'first',
  }] });
  rpc({ type: 'message_start', message: { role: 'assistant', timestamp: 290, content: 'background output' } });
  await vi.advanceTimersByTimeAsync(150);
  expect(usePiStore.getState().live[run.key]['290']._turnId).toBe('background-local');
  rpc({ type: 'message_start', message: { role: 'user', content: 'same' } });
  const boundary = usePiStore.getState().sends[1];
  expect(boundary.baseline).toEqual(['older-same', 'first']);
  const confirmed = confirmSends(usePiStore.getState().sends, history([user('older-same', 'same'), user('first', 'first'), user('new-same', 'same')]), run.key);
  expect(confirmed[1].confirmedId).toBe('new-same');
});

it('late disk refresh and settlement from a retired generation cannot confirm or clean up its replacement', async () => {
  usePiStore.setState({ runs: [{ ...run, pending: 0, queue: [] }] });
  let resolve!: (value: PiHistory) => void;
  api.history.mockImplementationOnce(() => new Promise<PiHistory>(done => { resolve = done; }));
  rpc({ type: 'agent_settled' });
  await vi.advanceTimersByTimeAsync(400);
  const replacement = { ...run, generation: 'replacement', status: 'idle' as const, pending: 0, queue: [] };
  emit({ type: 'run', run: replacement });
  const local = { id: 'new-local', key: run.key, at: 1, text: 'new local', images: [], baseline: [], promptDone: true };
  usePiStore.setState({ sends: [local] });
  resolve(history([user('stale', 'stale old disk')]));
  await vi.advanceTimersByTimeAsync(0);
  expect(usePiStore.getState().history?.branch).toEqual([user(`old-${serial}`, 'old')]);
  expect(usePiStore.getState().sends).toEqual([local]);
});

it('new generations discard received records, retain saved history, and reject late old RPCs', async () => {
  rpc({ type: 'message_start', message: { role: 'user', timestamp: 301, content: 'old received' } });
  rpc({ type: 'message_start', message: { role: 'assistant', timestamp: 302, content: 'old live' } });
  const saved = [user('disk-user', 'persisted history')];
  usePiStore.setState({ history: history(saved) });
  const replacement = { ...run, generation: 'replacement', pending: 0, queue: [] };
  emit({ type: 'run', run: replacement });
  rpc({ type: 'message_start', message: { role: 'user', content: 'late old user' } });
  rpc({ type: 'agent_settled' });
  emit({ type: 'rpc', key: run.key, generation: replacement.generation, event: { type: 'agent_start' } });
  emit({ type: 'rpc', key: run.key, generation: replacement.generation, event: { type: 'message_start', message: { role: 'assistant', timestamp: 303, content: 'new generation output' } } });
  await vi.advanceTimersByTimeAsync(150);
  expect(usePiStore.getState().sends).toEqual([]);
  expect(usePiStore.getState().history?.branch).toEqual(saved);
  expect(usePiStore.getState().runs[0].status).toBe('running');
  expect(JSON.stringify(messages())).not.toContain('old live');
  expect(JSON.stringify(messages())).not.toContain('late old user');
  expect(JSON.stringify(messages())).toContain('persisted history');
  expect(JSON.stringify(messages())).toContain('new generation output');
});

it('empty start with no content events stays empty at 137 seconds despite successful disk refresh', async () => {
  const branch = [user(`question-${serial}`, 'direct question')];
  usePiStore.setState({ history: history(branch) });
  rpc({ type: 'message_start', message: { role: 'assistant', timestamp: 1790492879269, content: [] } });
  await vi.advanceTimersByTimeAsync(137_000);
  await refresh(branch);
  expect(messages()).toHaveLength(1);
  expect(html()).toContain('pi-waiting-process');
  rpc({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'late content' } });
  await vi.advanceTimersByTimeAsync(150);
  expect(messages().at(-1)?.parts[0]).toMatchObject({ kind: 'thinking', text: 'late content' });
  expect(html()).not.toContain('pi-waiting-process');
});
