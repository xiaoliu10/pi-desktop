import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { PiBackend } from '../src/main/pi/backend';
import { SessionIndex } from '../src/main/pi/session-index';
import type { PiEvent } from '../src/shared/pi';

vi.mock('../src/main/pi/rpc-client', () => ({ PiRpcClient: class extends EventEmitter {
  calls: Array<{ type: string; data: any; timeout?: number }> = [];
  requestHook?: (type: string, data: any, timeout?: number) => Promise<any> | undefined;
  constructor(_command: string, _args: string[], _cwd: string, private env: any) { super(); }
  async request(type: string, data: any = {}, timeout?: number) {
    this.calls.push({ type, data, timeout });
    const hooked = this.requestHook?.(type, data, timeout); if (hooked) return hooked;
    if (type === 'get_state') {
      this.emit('event', { type: 'extension_ui_request', method: 'setStatus', statusKey: 'desktop-policy', statusText: 'ready' });
      this.emit('event', { type: 'extension_ui_request', method: 'setStatus', statusKey: 'desktop-retry-ready', statusText: this.env.PI_DESKTOP_GENERATION });
      return { isStreaming: false, pendingMessageCount: 0 };
    }
    if (type === 'clear_queue') { this.emit('event', { type: 'queue_update', steering: [], followUp: [] }); return { steering: [], followUp: [] }; }
    return {};
  }
  send() {}
  close() {}
} }));
const roots: string[] = [], backends: PiBackend[] = [];
afterEach(() => { backends.splice(0).forEach(b => b.dispose()); roots.splice(0).forEach(p => fs.rmSync(p, { recursive: true, force: true })); vi.useRealTimers(); });
async function setup(start = true) {
  vi.useFakeTimers();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-backend-')); roots.push(root);
  const owned = path.join(root, 'owned'), index = new SessionIndex([owned], owned), events: PiEvent[] = [];
  const backend = new PiBackend({ executable: 'fake', version: '0.86.0', supported: true, agentDir: root, sessionDirs: [], diagnostics: [] }, index, owned, path.resolve('extensions/desktop-policy/index.mjs'), e => events.push(structuredClone(e)));
  backends.push(backend);
  const view = await backend.connect({ cwd: root, trustProject: false, permission: 'ask' });
  const run = (backend as any).active.get(view.key);
  fs.writeFileSync(view.file, [
    { type: 'session', version: 3, id: 'fixture', cwd: root },
    { type: 'message', id: 'user', parentId: null, message: { role: 'user', content: 'original' } },
    { type: 'message', id: 'failed', parentId: 'user', message: { role: 'assistant', stopReason: 'error', content: [], errorMessage: '503 unavailable' } },
  ].map(e => JSON.stringify(e)).join('\n') + '\n');
  const event = (e: any) => run.client.emit('event', e);
  if (start) { await backend.prompt(view.key, 'original', 'followUp'); event({ type: 'agent_start' }); }
  const exhausted = () => {
    event({ type: 'message_end', message: { role: 'assistant', stopReason: 'error' } });
    event({ type: 'auto_retry_start', attempt: 3, maxAttempts: 3 });
    event({ type: 'auto_retry_end', success: false, attempt: 3, finalError: '503 unavailable' });
    event({ type: 'agent_settled' });
  };
  const continuationCalls = () => run.client.calls.filter((c: any) => c.type === 'prompt' && c.data.message.startsWith('/desktop-retry-'));
  return { root, backend, view, run, events, event, exhausted, continuationCalls };
}
it('holds the run across the inter-group boundary and dispatches one validated continuation', async () => {
  const { backend, view, run, events, event, exhausted, continuationCalls } = await setup();
  const startedAt = run.view.timing.startedAt;
  exhausted(); event({ type: 'agent_settled' });
  expect(run.view.status).toBe('running'); expect(run.view.timing).toEqual({ startedAt });
  expect(events.some(e => e.type === 'rpc' && e.event.type === 'agent_settled')).toBe(false);
  await backend.prompt(view.key, 'queued', 'followUp');
  expect(run.client.calls.filter((c: any) => c.type === 'prompt')).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(10000);
  expect(continuationCalls()).toHaveLength(1);
  expect(continuationCalls()[0].data.message).toContain('"entryId":"failed"');
  expect(continuationCalls()[0].data.message).not.toContain('original');
  event({ type: 'agent_start' });
  event({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } });
  event({ type: 'agent_settled' }); event({ type: 'agent_settled' });
  await Promise.resolve();
  expect(run.client.calls.filter((c: any) => c.type === 'prompt' && c.data.message === 'queued')).toHaveLength(1);
  expect(run.deferredQueue).toEqual([]);
});
it('stop cancels the timer synchronously and sends abort even if clear_queue is stalled', async () => {
  const { backend, view, run, event, exhausted, continuationCalls } = await setup(); exhausted();
  await backend.prompt(view.key, 'keep me', 'steer');
  let clear!: (value: any) => void;
  run.client.requestHook = (type: string) => type === 'clear_queue' ? new Promise(resolve => { clear = resolve; }) : undefined;
  const stop = backend.stop(view.key);
  expect(run.client.calls.at(-1).type).toBe('abort');
  event({ type: 'agent_start' }); // late event cannot escape stopping state
  expect(run.view.status).toBe('stopping');
  await vi.advanceTimersByTimeAsync(1200000);
  expect(continuationCalls()).toEqual([]);
  clear({ steering: [], followUp: [] });
  expect(await stop).toEqual({ steering: ['keep me'], followUp: [] });
  expect(run.view.retryGroup.phase).toBe('cancelled');
});
it('stop during the asynchronous preflight fences the already-fired timer', async () => {
  const { backend, view, run, exhausted, continuationCalls } = await setup(); exhausted();
  let state!: (value: any) => void;
  run.client.requestHook = (type: string) => type === 'get_state' ? new Promise(resolve => { state = resolve; }) : undefined;
  await vi.advanceTimersByTimeAsync(10000);
  await backend.stop(view.key);
  state({ isStreaming: false, pendingMessageCount: 0 }); await Promise.resolve();
  expect(continuationCalls()).toEqual([]);
});
it('disconnect/reconnect cancels old timers and ignores stale generation events', async () => {
  const { backend, view, run, exhausted, continuationCalls } = await setup(); exhausted();
  backend.close(view.key);
  const reconnected = await backend.connect({ sourceKey: view.key, trustProject: false, permission: 'ask' });
  expect(reconnected.generation).not.toBe(view.generation);
  exhausted(); run.client.emit('event', { type: 'agent_start' });
  await vi.advanceTimersByTimeAsync(1200000);
  expect(continuationCalls()).toEqual([]);
  expect(backend.runs()[0].retryGroup).toBeUndefined();
  expect(backend.runs()[0].status).toBe('idle');
});
it('does not replay on changed context or missing continuation capability', async () => {
  const { backend, view, run, exhausted, continuationCalls } = await setup(); exhausted();
  run.retryReady = false;
  await vi.advanceTimersByTimeAsync(10000);
  expect(run.view.retryGroup.phase).toBe('failed'); expect(run.view.status).toBe('error');
  expect(continuationCalls()).toEqual([]);
  await backend.stop(view.key);
  run.retryReady = true;
  await backend.prompt(view.key, 'new explicit prompt', 'followUp'); exhausted();
  fs.appendFileSync(view.file, JSON.stringify({ type: 'message', id: 'changed', parentId: 'failed', message: { role: 'user', content: 'changed' } }) + '\n');
  await vi.advanceTimersByTimeAsync(10000);
  expect(run.view.retryGroup.phase).toBe('failed'); expect(continuationCalls()).toEqual([]);
});
it('reports extension-command rejection despite the CLI prompt acceptance response', async () => {
  const { run, event, exhausted } = await setup(); exhausted();
  await vi.advanceTimersByTimeAsync(10000);
  event({ type: 'extension_error', extensionPath: `command:desktop-retry-${run.view.generation}`, event: 'command', error: 'Desktop retry context changed' });
  expect(run.view.retryGroup.phase).toBe('failed'); expect(run.view.status).toBe('error');
});
it('edits held inputs without clear/requeue RPC and preserves them after exhaustion until stop', async () => {
  const { backend, view, run, event, exhausted } = await setup(); exhausted();
  await backend.prompt(view.key, 'A', 'followUp'); await backend.prompt(view.key, 'B', 'followUp');
  await backend.queueEdit(view.key, { type: 'edit', index: 0, text: 'edited A' });
  await backend.queueEdit(view.key, { type: 'now', index: 1 });
  expect(run.view.queue.map((i: any) => i.text)).toEqual(['B', 'edited A']);
  expect(run.client.calls.filter((c: any) => c.type === 'clear_queue')).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(10000); event({ type: 'agent_start' });
  run.retry.state.group = 10; exhausted();
  expect(run.view.retryGroup.phase).toBe('exhausted'); expect(run.view.pending).toBe(2);
  expect(await backend.stop(view.key)).toEqual({ steering: ['B'], followUp: ['edited A'] });
});
it('pins the failed entry at settlement instead of retrying a newer error from changed context', async () => {
  const { view, run, exhausted, continuationCalls } = await setup(); exhausted();
  fs.appendFileSync(view.file, JSON.stringify({ type: 'message', id: 'different-error', parentId: 'failed', message: { role: 'assistant', stopReason: 'error', content: [] } }) + '\n');
  await vi.advanceTimersByTimeAsync(10000);
  expect(run.view.retryGroup.phase).toBe('failed'); expect(continuationCalls()).toEqual([]);
});
it('keeps all ten groups when the original prompt ACK times out after five minutes', async () => {
  const { backend, view, run, event, exhausted, continuationCalls } = await setup(false);
  run.client.requestHook = (type: string, data: any, timeout: number) => type === 'prompt' && data.message === 'original'
    ? new Promise((_, reject) => setTimeout(() => reject(new Error('prompt 超时')), timeout)) : undefined;
  const prompt = backend.prompt(view.key, 'original', 'followUp');
  event({ type: 'agent_start' });
  await vi.advanceTimersByTimeAsync(290000);
  exhausted(); await vi.advanceTimersByTimeAsync(10000); event({ type: 'agent_start' });
  await expect(prompt).resolves.toBeUndefined();
  expect(run.retry.state).toMatchObject({ group: 2, phase: 'running' });
  for (const delay of [20000, 40000, 80000, 160000, 300000, 600000, 900000, 1200000]) {
    exhausted(); await vi.advanceTimersByTimeAsync(delay); event({ type: 'agent_start' });
  }
  exhausted(); expect(run.retry.state).toMatchObject({ group: 10, phase: 'exhausted' });
  expect(continuationCalls()).toHaveLength(9);
});
it('does not let the five-minute prompt timeout cancel a later outer backoff timer', async () => {
  const { backend, view, run, event, exhausted } = await setup(false);
  run.client.requestHook = (type: string, data: any, timeout: number) => type === 'prompt' && data.message === 'original'
    ? new Promise((_, reject) => setTimeout(() => reject(new Error('prompt 超时')), timeout)) : undefined;
  const prompt = backend.prompt(view.key, 'original', 'followUp'); event({ type: 'agent_start' });
  for (const delay of [10000, 20000, 40000, 80000]) { exhausted(); await vi.advanceTimersByTimeAsync(delay); event({ type: 'agent_start' }); }
  exhausted(); // group 5 backoff spans original request's 300s deadline
  await vi.advanceTimersByTimeAsync(150001); await prompt;
  expect(run.retry.state).toMatchObject({ group: 5, phase: 'waiting' });
  await vi.advanceTimersByTimeAsync(9999);
  expect(run.retry.state).toMatchObject({ group: 6, phase: 'running' });
});
it('preserves Stop on ambiguous continuation ACK and never redispatches', async () => {
  const { backend, view, run, exhausted, continuationCalls } = await setup(); exhausted();
  run.client.requestHook = (type: string, data: any, timeout: number) => type === 'prompt'
    ? new Promise((_, reject) => setTimeout(() => reject(new Error('prompt 超时')), timeout)) : undefined;
  await vi.advanceTimersByTimeAsync(20000);
  expect(run.view.retryGroup.phase).toBe('failed'); expect(run.view.status).toBe('running');
  await vi.advanceTimersByTimeAsync(1200000); expect(continuationCalls()).toHaveLength(1);
  await backend.stop(view.key); expect(run.view.status).toBe('idle');
});
it('late continuation ACK rejection cannot cancel the next scheduled group', async () => {
  const { run, event, exhausted } = await setup(); exhausted();
  let reject!: (e: Error) => void;
  run.client.requestHook = (type: string) => type === 'prompt' ? new Promise((_, r) => { reject = r; }) : undefined;
  await vi.advanceTimersByTimeAsync(10000); event({ type: 'agent_start' }); exhausted();
  reject(new Error('prompt 超时')); await Promise.resolve(); await Promise.resolve();
  expect(run.retry.state).toMatchObject({ group: 2, phase: 'waiting' });
});
it.each(['clear_queue', 'abort'])('retains held inputs and images when Stop %s rejects, including late queue events', async failed => {
  const { backend, view, run, event, exhausted } = await setup(); exhausted();
  const images = [{ type: 'image' as const, mimeType: 'image/png', data: 'YQ==' }];
  await backend.prompt(view.key, 'keep me', 'followUp', images);
  run.client.requestHook = (type: string) => type === failed ? Promise.reject(new Error('RPC rejected')) : undefined;
  await expect(backend.stop(view.key)).rejects.toThrow('RPC rejected');
  event({ type: 'queue_update', steering: [], followUp: [] }); event({ type: 'agent_settled' });
  expect(run.view.queue).toEqual([{ text: 'keep me', behavior: 'followUp', images }]);
  expect(run.view.status).toBe('running');
  await expect(backend.prompt(view.key, 'do not send', 'followUp')).rejects.toThrow();
  run.client.requestHook = undefined;
  expect(await backend.stop(view.key)).toEqual({ steering: [], followUp: ['keep me'] });
});
it('retains cleared remote inputs if abort rejects, so a subsequent Stop can return them', async () => {
  const { backend, view, run } = await setup();
  const images = [{ type: 'image' as const, mimeType: 'image/png', data: 'YQ==' }];
  run.view.queue = [{ text: 'remote', behavior: 'followUp', images }];
  run.client.requestHook = (type: string) => type === 'abort' ? Promise.reject(new Error('abort failed'))
    : type === 'clear_queue' ? Promise.resolve({ steering: [], followUp: ['remote'] }) : undefined;
  await expect(backend.stop(view.key)).rejects.toThrow();
  expect(run.deferredQueue).toEqual([{ text: 'remote', behavior: 'followUp', images }]);
  run.client.requestHook = undefined;
  expect(await backend.stop(view.key)).toEqual({ steering: [], followUp: ['remote'] });
});
it('recovers remote text by occurrence when a rejected clear actually emptied the queue', async () => {
  const { backend, view, run } = await setup();
  run.view.queue = [{ text: 'duplicate', behavior: 'followUp' }, { text: 'duplicate', behavior: 'followUp' }];
  run.client.requestHook = (type: string) => type === 'clear_queue' ? Promise.reject(new Error('clear ACK timeout')) : undefined;
  await expect(backend.stop(view.key)).rejects.toThrow();
  run.client.requestHook = undefined; // next clear returns empty: first clear may have succeeded
  expect(await backend.stop(view.key)).toEqual({ steering: [], followUp: ['duplicate', 'duplicate'] });
});
it('uses a token-fenced idle handshake when native settlement is absent', async () => {
  const { run, event, continuationCalls } = await setup();
  event({ type: 'message_end', message: { role: 'assistant', stopReason: 'error' } });
  event({ type: 'auto_retry_start', attempt: 3, maxAttempts: 3 });
  event({ type: 'auto_retry_end', success: false, attempt: 3, finalError: '503 unavailable' });
  await vi.advanceTimersByTimeAsync(250);
  const token = run.settlement.token;
  const signal = (t: string) => event({ type: 'extension_ui_request', method: 'setStatus', statusKey: 'desktop-retry-settled', statusText: JSON.stringify({ generation: run.view.generation, token: t }) });
  signal('stale'); expect(run.retry.state.phase).toBe('running');
  signal(token); expect(run.retry.state.phase).toBe('waiting');
  await vi.advanceTimersByTimeAsync(10000);
  expect(continuationCalls().filter((c: any) => !c.data.message.includes('-settle '))).toHaveLength(1);
});
it('reports missing settlement capability explicitly instead of silently performing zero outer retries', async () => {
  const { run, event } = await setup(); run.retryReady = false;
  event({ type: 'message_end', message: { role: 'assistant', stopReason: 'error' } });
  event({ type: 'auto_retry_start', attempt: 3, maxAttempts: 3 });
  event({ type: 'auto_retry_end', success: false, attempt: 3, finalError: '503 unavailable' });
  await vi.advanceTimersByTimeAsync(250);
  expect(run.retry.state.phase).toBe('failed'); expect(run.view.error).toContain('无法自动续接');
  expect(run.view.status).toBe('running');
});
it('new independently queued task starts at group one, not the preceding task budget', async () => {
  const { backend, view, run, event } = await setup();
  await backend.prompt(view.key, 'independent queued task', 'followUp');
  run.retry.state.group = 9;
  event({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } });
  event({ type: 'agent_start' }); expect(run.retry.state.group).toBe(9);
  event({ type: 'message_start', message: { role: 'user', content: 'independent queued task' } });
  expect(run.retry.state).toMatchObject({ group: 1, phase: 'running' });
});
it('stop prevents a pending queueEdit from dispatching inputs after clear_queue', async () => {
  const { backend, view, run } = await setup();
  run.view.queue = [{ text: 'queued', behavior: 'followUp' }];
  let resolve!: (value: any) => void, first = true;
  run.client.requestHook = (type: string) => {
    if (type === 'clear_queue' && first) { first = false; return new Promise(r => { resolve = r; }); }
  };
  const edit = backend.queueEdit(view.key, { type: 'edit', index: 0, text: 'edited' });
  await backend.stop(view.key); resolve({ steering: [], followUp: [] }); await edit;
  expect(run.client.calls.filter((c: any) => c.type === 'prompt')).toHaveLength(1);
});
