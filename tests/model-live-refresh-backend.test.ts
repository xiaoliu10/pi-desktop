import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { PiBackend } from '../src/main/pi/backend';
import { SessionIndex } from '../src/main/pi/session-index';
import { PiHost } from '../src/main/pi/host';

const roots: string[] = [], backends: PiBackend[] = [];
afterEach(() => { backends.splice(0).forEach(b => b.dispose()); roots.splice(0).forEach(p => fs.rmSync(p, { recursive: true, force: true })); vi.useRealTimers(); });
async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-refresh-backend-')); roots.push(root);
  const owned = path.join(root, 'owned');
  let model = { provider: 'alpha', id: 'switched', name: 'old', reasoning: true }, thinkingLevel = 'medium';
  let levels = ['off', 'minimal', 'low', 'medium', 'high'];
  const calls: any[] = [], events: any[] = [];
  const client: any = new EventEmitter();
  const generation = () => backend.runs()[0].generation;
  const signal = (token: string, extra = {}, gen = generation()) => client.emit('event', { type: 'extension_ui_request', method: 'setStatus', statusKey: 'desktop-model-refresh-result', statusText: JSON.stringify({ generation: gen, token, status: 'refreshed', ...extra }) });
  let dispatch: (r: any) => void = r => { model = { ...model, name: 'fresh' }; levels = [...levels, 'max']; signal(r.token); };
  client.request = vi.fn(async (type: string, data: any = {}) => {
    calls.push({ type, data });
    if (type === 'get_state') {
      client.emit('event', { type: 'extension_ui_request', method: 'setStatus', statusKey: 'desktop-policy', statusText: 'ready' });
      client.emit('event', { type: 'extension_ui_request', method: 'setStatus', statusKey: 'desktop-model-refresh-ready', statusText: generation() });
      return { model, thinkingLevel, isStreaming: false, pendingMessageCount: 0 };
    }
    if (type === 'get_commands') return { commands: [{ name: `desktop-model-refresh-${generation()}` }] };
    if (type === 'get_available_models') return { models: [model, { ...model, provider: 'beta', name: 'other' }] };
    if (type === 'get_available_thinking_levels') return { levels };
    if (type === 'prompt') { dispatch(JSON.parse(data.message.slice(data.message.indexOf(' ') + 1))); return { disposition: 'handled' }; }
    return {};
  });
  client.close = () => {}; client.send = () => {};
  const backend = new PiBackend({ executable: 'fake', version: '1.2.0', supported: true, agentDir: root, sessionDirs: [], diagnostics: [] }, new SessionIndex([owned], owned), owned, path.resolve('extensions/desktop-policy/index.mjs'), e => events.push(structuredClone(e)));
  backend.clientFactory = () => client; backends.push(backend);
  const view = await backend.connect({ cwd: root, trustProject: false, permission: 'ask', model: 'alpha/original' });
  calls.length = 0;
  return { root, backend, view, run: (backend as any).active.get(view.key), calls, events, signal, client, setDispatch: (fn: typeof dispatch) => { dispatch = fn; } };
}
it('manual refresh executes the internal bridge then reads state/models/levels, not the launch model', async () => {
  const { backend, view, calls } = await setup();
  expect(await backend.refreshModels(view.key)).toMatchObject({ status: 'refreshed', count: 2 });
  expect(calls.find(c => c.type === 'prompt').data.message).toContain('/desktop-model-refresh-');
  expect(calls.slice(-3).map(c => c.type)).toEqual(['get_state', 'get_available_models', 'get_available_thinking_levels']);
  expect(backend.runs()[0]).toMatchObject({ model: { provider: 'alpha', id: 'switched', name: 'fresh' }, thinkingLevel: 'medium', thinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'max'] });
  expect(backend.runs()[0].commands).toEqual([]);
});
it.each(['running', 'starting', 'stopping', 'compacting', 'dialog', 'queue', 'retry', 'uncertain'])('defers %s and coalesces repeated saves until safe idle', async busy => {
  const { backend, view, run, calls, client } = await setup();
  if (['running', 'starting', 'stopping'].includes(busy)) run.view.status = busy;
  if (busy === 'compacting') run.view.compacting = true;
  if (busy === 'dialog') run.dialogs.set('d', {});
  if (busy === 'queue') run.view.pending = 1;
  if (busy === 'retry') { run.retry.begin(); }
  if (busy === 'uncertain') run.retryUncertain = true;
  expect(await backend.refreshModels(view.key)).toMatchObject({ status: 'pending' });
  expect(await backend.refreshModels(view.key)).toMatchObject({ status: 'pending' });
  expect(calls.filter(c => c.type === 'prompt')).toHaveLength(0);
  run.view.status = 'idle'; run.view.compacting = false; run.view.pending = 0; run.dialogs.clear(); run.retry.cancel(); run.retryUncertain = false;
  client.emit('event', { type: 'agent_settled' });
  await vi.waitFor(() => expect(calls.filter(c => c.type === 'prompt')).toHaveLength(1));
  await vi.waitFor(() => expect(run.view.modelRefresh.status).toBe('refreshed'));
});
it('joins concurrent refreshes and repeats once for a save arriving during refresh', async () => {
  const { backend, view, setDispatch, signal, calls } = await setup();
  const tokens: string[] = []; setDispatch(r => { tokens.push(r.token); });
  const one = backend.refreshModels(view.key); await vi.waitFor(() => expect(tokens).toHaveLength(1));
  const two = backend.refreshModels(view.key); signal(tokens[0]);
  await vi.waitFor(() => expect(tokens).toHaveLength(2)); signal(tokens[1]);
  await Promise.all([one, two]); expect(calls.filter(c => c.type === 'prompt')).toHaveLength(2);
});
it('missing capability fails explicitly and never submits an unknown slash command as a prompt', async () => {
  const { backend, view, run, calls } = await setup(); run.modelRefreshReady = false;
  await expect(backend.refreshModels(view.key)).rejects.toThrow('重连');
  expect(calls.filter(c => c.type === 'prompt')).toEqual([]);
  expect(run.view.thinkingLevels).toEqual(['off', 'minimal', 'low', 'medium', 'high']);
});
it('sanitizes error receipts and retains prior levels; stale tokens/generations cannot finish refresh', async () => {
  const { backend, view, run, setDispatch, signal } = await setup();
  const tokens: string[] = []; setDispatch(r => { tokens.push(r.token); });
  const pending = backend.refreshModels(view.key); const rejected = expect(pending).rejects.toThrow('模型配置');
  await vi.waitFor(() => expect(tokens).toHaveLength(1));
  signal('old'); signal(tokens[0], {}, 'old-generation'); await Promise.resolve();
  expect(run.view.modelRefresh.status).toBe('refreshing');
  signal(tokens[0], { status: 'error', code: 'config', error: 'secret-fixture' });
  await rejected;
  expect(JSON.stringify(run.view)).not.toContain('secret-fixture');
  expect(run.view.thinkingLevels).toHaveLength(5);
});
it('times out fail-closed, and late receipts cannot publish success or clear old levels', async () => {
  const { backend, view, run, setDispatch, signal, calls } = await setup();
  vi.useFakeTimers(); let token = ''; setDispatch(r => { token = r.token; });
  const refresh = backend.refreshModels(view.key); const rejected = expect(refresh).rejects.toThrow('超时');
  await vi.advanceTimersByTimeAsync(31_000); await rejected;
  signal(token); await Promise.resolve();
  expect(run.view.modelRefresh.status).toBe('error'); expect(run.view.thinkingLevels).toHaveLength(5);
  await expect(backend.prompt(view.key, 'not while uncertain', 'followUp')).rejects.toThrow('重连');
  expect(calls.filter(c => c.type === 'prompt')).toHaveLength(1);
});
it('blocks new sends, model switches, compaction and session reload during asynchronous refresh', async () => {
  const { backend, view, setDispatch, signal } = await setup(); let token = ''; setDispatch(r => { token = r.token; });
  const refresh = backend.refreshModels(view.key); await vi.waitFor(() => expect(token).not.toBe(''));
  await expect(backend.prompt(view.key, 'new', 'followUp')).rejects.toThrow('刷新');
  await expect(backend.model(view.key, 'beta', 'switched')).rejects.toThrow('刷新');
  await expect(backend.thinking(view.key, 'high')).rejects.toThrow('刷新');
  await expect(backend.compact(view.key)).rejects.toThrow('刷新');
  await expect(backend.reloadSession(view.key)).rejects.toThrow('刷新');
  signal(token); await refresh;
});
it('closing invalidates a pending refresh and ignores its late result', async () => {
  const { backend, view, setDispatch, signal, events } = await setup(); let token = ''; setDispatch(r => { token = r.token; });
  const refresh = backend.refreshModels(view.key); const rejected = expect(refresh).rejects.toThrow();
  await vi.waitFor(() => expect(token).not.toBe('')); backend.close(view.key); await rejected;
  const n = events.length; signal(token, {}, view.generation); await Promise.resolve();
  expect(events).toHaveLength(n); expect(backend.runs()).toEqual([]);
});
it('the real host save boundary writes first and reports refresh failure/pending instead of false success', async () => {
  const { root, backend, view, run } = await setup();
  const host = Object.create(PiHost.prototype) as PiHost; host.environment = { agentDir: root } as any; host.backend = backend;
  run.view.status = 'running';
  const draft = { id: 'alpha', baseUrl: 'https://example.invalid', api: 'anthropic-messages', apiKey: 'synthetic', models: [{ id: 'switched', reasoning: true, thinkingLevelMap: { max: 'max' } }] };
  const saved = await host.modelProviderSave(draft);
  expect(JSON.parse(fs.readFileSync(path.join(root, 'models.json'), 'utf8')).providers.alpha.models[0].thinkingLevelMap).toEqual({ max: 'max' });
  expect(saved.sessionRefresh).toEqual({ refreshed: 0, pending: 1, failed: 0 });
  run.view.status = 'idle'; run.modelRefreshReady = false;
  const failed = await host.modelProviderSave(draft);
  expect(failed.sessionRefresh.failed).toBe(1); expect(failed.warning).toContain('重连');
  expect(run.view.modelRefresh.status).toBe('error'); expect(view.key).toBeTruthy();
});
