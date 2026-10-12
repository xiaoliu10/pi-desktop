import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { PiBackend } from '../src/main/pi/backend';
import { SessionIndex } from '../src/main/pi/session-index';
import type { PiEvent } from '../src/shared/pi';

// Match local toJsonEvent: updates have usage + assistantMessageEvent, NOT message/partial.
// Provider final output is only supplied at message_end; no fabricated live token counts.
vi.mock('../src/main/pi/rpc-client', () => ({ piLogDir: path.join(os.tmpdir(), 'pi-output-perf-log'), PiRpcClient: class extends EventEmitter {
  calls: string[] = [];
  stats: any = { tokens: { input: 200, output: 10, cacheRead: 50, cacheWrite: 50, total: 310 }, contextUsage: { tokens: 4000, contextWindow: 10000, percent: 40 } };
  requestHook?: (type: string) => Promise<any> | undefined;
  async request(type: string) {
    this.calls.push(type);
    const hooked = this.requestHook?.(type); if (hooked) return hooked;
    if (type === 'get_state') {
      this.emit('event', { type: 'extension_ui_request', method: 'setStatus', statusKey: 'desktop-policy', statusText: 'ready' });
      return { isStreaming: false, pendingMessageCount: 0 };
    }
    if (type === 'get_session_stats') return this.stats;
    if (type === 'get_messages') return { messages: [] };
    return {};
  }
  send() {}
  close() {}
  stderrDetail() { return ''; }
} }));

const roots: string[] = [], backends: PiBackend[] = [];
afterEach(() => {
  backends.splice(0).forEach(b => b.dispose());
  roots.splice(0).forEach(p => fs.rmSync(p, { recursive: true, force: true }));
  vi.restoreAllMocks();
});
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
async function setup() {
  let clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-output-perf-')); roots.push(root);
  const owned = path.join(root, 'owned'), index = new SessionIndex([owned], owned), events: PiEvent[] = [];
  const backend = new PiBackend({ executable: 'fake', version: '1.1.0', supported: true, agentDir: root, sessionDirs: [], diagnostics: [] }, index, owned, path.resolve('extensions/desktop-policy/index.mjs'), e => events.push(structuredClone(e)));
  backends.push(backend);
  const view = await backend.connect({ cwd: root, trustProject: false, permission: 'ask' });
  const run = (backend as any).active.get(view.key);
  fs.writeFileSync(view.file, [
    { type: 'session', version: 3, id: 'fixture', cwd: root },
    // Historical provider output must NOT be reconstructed into timed output.
    { type: 'message', id: 'historical', message: { role: 'assistant', content: [{ type: 'text', text: 'history' }], usage: { output: 9999 }, timestamp: 1 } },
  ].map(e => JSON.stringify(e)).join('\n') + '\n');
  const event = (e: any, ms = 0, target = run) => { clock += ms; target.client.emit('event', e); };
  const msg = (timestamp: number, over: any = {}) => ({ role: 'assistant', timestamp, api: 'test-api', provider: 'test-provider', model: 'test-model', content: [], stopReason: 'pending', ...over });
  const start = (timestamp: number, target = run) => event({ type: 'message_start', message: msg(timestamp) }, 0, target);
  const delta = (text: string, ms = 0, target = run) => event({ type: 'message_update', usage: { output: 0 }, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: text } }, ms, target);
  const textStart = (target = run) => event({ type: 'message_update', usage: { output: 0 }, assistantMessageEvent: { type: 'text_start', contentIndex: 0 } }, 0, target);
  const end = (timestamp: number, output = 100, ms = 100, target = run, stopReason = 'stop', text = 'answer') => event({ type: 'message_end', message: msg(timestamp, { stopReason, content: [{ type: 'text', text }], usage: { output } }) }, ms, target);
  const sample = (timestamp: number, output = 100, duration = 100, target = run) => { start(timestamp, target); textStart(target); delta('answer', 5000, target); end(timestamp, output, duration, target); };
  await flush();
  return { root, backend, view, run, events, event, start, delta, textStart, end, sample };
}

it('weights calls, excludes tool/approval wait, stats refresh cannot overwrite outputPerformance', async () => {
  const s = await setup();
  expect(s.run.view.outputPerformance).toBeUndefined();
  s.sample(10, 100, 100);
  s.event({ type: 'tool_execution_start', toolCallId: 'tc', toolName: 'bash' }, 50_000);
  s.event({ type: 'extension_ui_request', id: 'ask', method: 'confirm' }, 60_000);
  s.event({ type: 'tool_execution_end', toolCallId: 'tc', result: {} }, 70_000);
  s.sample(20, 150, 300);
  await flush();
  expect(s.run.view.outputPerformance).toEqual({ tokens: 250, ms: 400, calls: 2 });
  expect(s.run.view.stats.tokens.output).toBe(10); // independent RPC snapshot
  expect(s.events.some(e => e.type === 'run' && e.run.outputPerformance?.calls === 2)).toBe(true);
});

it('delta stream adds no run IPC, no RPC requests, and no timers; only completion publishes totals', async () => {
  const s = await setup(); s.start(10); s.textStart();
  const runsBefore = s.events.filter(e => e.type === 'run').length;
  const requestsBefore = s.run.client.calls.length;
  const timer = vi.spyOn(globalThis, 'setTimeout');
  for (let i = 0; i < 100; i++) s.delta('a', 1);
  expect(s.events.filter(e => e.type === 'run')).toHaveLength(runsBefore);
  expect(s.run.client.calls).toHaveLength(requestsBefore);
  expect(timer).not.toHaveBeenCalled();
  expect(s.run.view.outputPerformance).toBeUndefined();
  s.end(10, 100, 1, s.run, 'stop', 'a'.repeat(100));
  expect(s.events.filter(e => e.type === 'run')).toHaveLength(runsBefore + 1);
  expect(s.run.view.outputPerformance).toEqual({ tokens: 100, ms: 100, calls: 1 });
});

it('tool-only stream uses real RPC id/toolName fields and final provider usage', async () => {
  const s = await setup(); s.start(10);
  const update = (type: string, fields: any, ms = 0) => s.event({ type: 'message_update', usage: { output: 0 }, assistantMessageEvent: { type, contentIndex: 0, ...fields } }, ms);
  update('toolcall_start', { id: 'tc', toolName: 'bash' });
  update('toolcall_delta', { delta: '{"command":"pwd"}' }, 9000);
  const toolCall = { type: 'toolCall', id: 'tc', name: 'bash', arguments: { command: 'pwd' } };
  update('toolcall_end', { toolCall }, 100);
  s.event({ type: 'message_end', message: { role: 'assistant', timestamp: 10, api: 'test-api', provider: 'test-provider', model: 'test-model', stopReason: 'toolUse', content: [toolCall], usage: { output: 80 } } });
  expect(s.run.view.outputPerformance).toEqual({ tokens: 80, ms: 100, calls: 1 });
});

it.each(['error', 'aborted'])('excludes %s and duplicate end, clears pending at abort synchronously', async stopReason => {
  const s = await setup(); s.start(10); s.textStart(); s.delta('answer'); s.end(10, 999, 100, s.run, stopReason);
  s.end(10, 999); expect(s.run.view.outputPerformance).toBeUndefined();
  s.start(20); s.textStart(); s.delta('answer');
  const stopped = s.backend.stop(s.view.key);
  s.end(20, 999); // stop has already cleared pending before await
  s.sample(30, 999); // late starts while stopping also fenced
  await stopped;
  expect(s.run.view.outputPerformance).toBeUndefined();
  s.sample(40, 50);
  expect(s.run.view.outputPerformance).toEqual({ tokens: 50, ms: 100, calls: 1 });
});

it('isolates two runs in ONE backend and rejects old generation events after refresh/reconnect', async () => {
  const s = await setup(); s.sample(10);
  const second = await s.backend.connect({ cwd: s.root, trustProject: false, permission: 'ask' });
  const runB = (s.backend as any).active.get(second.key);
  expect(runB.view.outputPerformance).toBeUndefined();
  s.sample(10, 50, 200, runB);
  expect(s.run.view.outputPerformance).toEqual({ tokens: 100, ms: 100, calls: 1 });
  expect(runB.view.outputPerformance).toEqual({ tokens: 50, ms: 200, calls: 1 });
  const refreshed = await s.backend.refresh(s.view.key);
  await flush();
  expect(refreshed.generation).not.toBe(s.view.generation);
  expect(refreshed.outputPerformance).toBeUndefined();
  const current = (s.backend as any).active.get(refreshed.key);
  s.sample(20, 999, 100, s.run); // old client callback after refresh
  expect(current.view.outputPerformance).toBeUndefined();
  s.sample(20, 20, 200, current);
  expect(current.view.outputPerformance).toEqual({ tokens: 20, ms: 200, calls: 1 });
  expect(runB.view.outputPerformance).toEqual({ tokens: 50, ms: 200, calls: 1 });
});

it('compaction null context clears stale usage; historic stats alone produce no speed', async () => {
  const s = await setup();
  expect(s.run.view.stats.tokens.total).toBe(310);
  expect(s.run.view.contextUsage.tokens).toBe(4000);
  expect(s.run.view.outputPerformance).toBeUndefined();
  s.sample(10);
  s.run.client.stats = { ...s.run.client.stats, contextUsage: { tokens: null, contextWindow: 10000, percent: null } };
  s.event({ type: 'compaction_end', aborted: false });
  s.event({ type: 'agent_settled' }); await flush();
  expect(s.run.view.contextUsage).toBeUndefined();
  expect(s.run.view.outputPerformance).toEqual({ tokens: 100, ms: 100, calls: 1 });
});

it('late stats response and events cannot restore speed into a new connection', async () => {
  const s = await setup();
  let resolve!: (data: any) => void;
  s.run.client.requestHook = (type: string) => type === 'get_session_stats' ? new Promise(r => { resolve = r; }) : undefined;
  s.sample(10); // starts an async stats request
  await s.backend.refresh(s.view.key);
  const current = s.backend.runs().find(r => r.key === s.view.key)!;
  resolve({ ...s.run.client.stats, outputPerformance: { tokens: 999999, ms: 1, calls: 1 } });
  await flush();
  expect(current.outputPerformance).toBeUndefined();
  s.end(10, 999999);
  expect(current.outputPerformance).toBeUndefined();
});

it('unexpected disconnect clears speed in the terminal run snapshot', async () => {
  const s = await setup(); s.sample(10);
  s.run.client.emit('closed');
  const last = s.events.filter((e): e is Extract<PiEvent, { type: 'run' }> => e.type === 'run').at(-1)!;
  expect(last.run.status).toBe('error');
  expect(last.run.outputPerformance).toBeUndefined();
  expect(s.backend.runs()).toHaveLength(0);
});
