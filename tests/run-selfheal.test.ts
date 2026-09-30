import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { PiBackend } from '../src/main/pi/backend'; import { SessionIndex } from '../src/main/pi/session-index'; import type { PiEvent } from '../src/shared/pi';

const roots: string[] = [], backends: PiBackend[] = [];
afterEach(() => { backends.splice(0).forEach(b => b.dispose()); roots.splice(0).forEach(p => fs.rmSync(p, { recursive: true, force: true })); });
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-selfheal-')); roots.push(root);
  const owned = path.join(root, 'desktop'); fs.mkdirSync(owned, { recursive: true });
  const index = new SessionIndex([root, owned], owned);
  const events: PiEvent[] = [];
  const backend = new PiBackend({ executable: path.resolve('tests/fixtures/fake-pi.mjs'), version: '0.87.0', supported: true, agentDir: root, sessionDirs: [root], diagnostics: [] }, index, owned, path.resolve('extensions/desktop-policy/index.mjs'), e => events.push(structuredClone(e)));
  backends.push(backend);
  return { root, owned, index, events, backend };
}
const runEvents = (events: PiEvent[]) => events.filter(e => e.type === 'run') as Array<Extract<PiEvent, { type: 'run' }>>;
async function waitStatus(backend: PiBackend, key: string, status: string, timeout = 8000) {
  const at = Date.now();
  while (Date.now() - at < timeout) {
    const run = (backend as any).active.get(key);
    if (run?.view.status === status) return run;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error(`run 未进入 ${status} 状态`);
}
/** 把 run 伪装成已静默超过阈值（真实场景：结算事件丢失后 pi 与 Desktop 双向沉默）。 */
const backdate = (run: any, ms = 130_000) => { run.lastEventAt = Date.now() - ms; };

it('假 running 自愈：结算事件丢失时按 pi 侧 get_state 拉直为 idle，endedAt 取转写末条真实时间', async () => {
  const { backend, events } = setup();
  const view = await backend.connect({ cwd: process.cwd(), trustProject: false, permission: 'ask' });
  await backend.prompt(view.key, '/stuck', 'followUp');
  const run = await waitStatus(backend, view.key, 'running');
  // 模拟真实时间线：本轮 2 分钟前开始，转写末条在 1 分钟前（完成时刻）。
  run.view.timing = { startedAt: Date.now() - 120_000 };
  const doneAt = Date.now() - 60_000;
  fs.appendFileSync(view.file, JSON.stringify({ type: 'message', id: 'last', timestamp: new Date(doneAt).toISOString(), message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'done' }] } }) + '\n');
  backdate(run);
  (backend as any).stuckScan();
  await vi.waitFor(() => {
    const last = runEvents(events).at(-1)!;
    expect(last.run.status).toBe('idle');
  });
  const last = runEvents(events).at(-1)!;
  expect(Math.abs((last.run.timing?.endedAt ?? 0) - doneAt)).toBeLessThan(5_000);
  expect((backend as any).active.get(view.key).view.status).toBe('idle');
});

it('真实在跑（静默长工具，get_state isStreaming=true）不被误杀：拉直后仍 running', async () => {
  const { backend, events } = setup();
  const view = await backend.connect({ cwd: process.cwd(), trustProject: false, permission: 'ask' });
  await backend.prompt(view.key, '/long', 'followUp');
  const run = await waitStatus(backend, view.key, 'running');
  const mark = events.length;
  backdate(run);
  (backend as any).stuckScan();
  // get_state 会返回 isStreaming=true：核实后只刷新静默起点，绝不能翻 idle。
  await new Promise(r => setTimeout(r, 300));
  expect((backend as any).active.get(view.key).view.status).toBe('running');
  const statuses = runEvents(events.slice(mark)).map(e => e.run.status);
  expect(statuses.filter(s => s === 'idle').length).toBe(0);
});

it('沉默不足阈值或处于停止/重试流程时不核实、不拉直', async () => {
  const { backend, events } = setup();
  const view = await backend.connect({ cwd: process.cwd(), trustProject: false, permission: 'ask' });
  await backend.prompt(view.key, '/stuck', 'followUp');
  const run = await waitStatus(backend, view.key, 'running');
  const mark = events.length;
  // 沉默时间不够：扫描应跳过。
  (backend as any).stuckScan();
  await new Promise(r => setTimeout(r, 200));
  expect((backend as any).active.get(view.key).view.status).toBe('running');
  // 停止未确认（30s 兜底流程中）：不得干预。
  run.stopUnconfirmed = true; backdate(run);
  (backend as any).stuckScan();
  await new Promise(r => setTimeout(r, 200));
  expect((backend as any).active.get(view.key).view.status).toBe('running');
  const statuses = runEvents(events.slice(mark)).map(e => e.run.status);
  expect(statuses.filter(s => s === 'idle').length).toBe(0);
});

it('watchdog 只启动一次、dispose 时清除', async () => {
  const { backend } = setup();
  expect((backend as any).watchdog).toBeUndefined();
  await backend.connect({ cwd: process.cwd(), trustProject: false, permission: 'ask' });
  const first = (backend as any).watchdog;
  expect(first).toBeDefined();
  await backend.connect({ cwd: process.cwd(), trustProject: false, permission: 'autoEdit' });
  expect((backend as any).watchdog).toBe(first);
  backend.dispose();
  expect((backend as any).watchdog).toBeUndefined();
});
