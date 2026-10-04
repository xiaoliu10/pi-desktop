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

it('holding 自愈：续接轮结算丢失（组状态机卡 running）→ 按转写末条落定组 + run idle，横幅随组退场', async () => {
  const { backend, events } = setup();
  const view = await backend.connect({ cwd: process.cwd(), trustProject: false, permission: 'ask' });
  await backend.prompt(view.key, '/stuck', 'followUp');
  const run = await waitStatus(backend, view.key, 'running');
  // 注入持有期状态：第 4/10 组 running（对应横幅"等待模型响应…"），上一轮 assistant 以 stop 收尾。
  (run.retry as any).begin();
  (run.retry as any).lastOutcome = 'stop';
  (run.retry as any).publish({ group: 4, phase: 'running' });
  run.view.timing = { startedAt: Date.now() - 120_000 };
  backdate(run, 601_000);
  (backend as any).stuckScan();
  await vi.waitFor(() => {
    const last = runEvents(events).at(-1)!;
    expect(last.run.status).toBe('idle');
  });
  expect((backend as any).active.get(view.key).view.status).toBe('idle');
  expect(run.view.retryGroup).toMatchObject({ group: 4, phase: 'completed' });
  expect((run.retry as any).active).toBe(false);
});

it('holding 自愈中间态：组耗尽待退避（exhausted+error）→ 合成结算排下组，run 保持 running', async () => {
  const { backend } = setup();
  const view = await backend.connect({ cwd: process.cwd(), trustProject: false, permission: 'ask' });
  await backend.prompt(view.key, '/stuck', 'followUp');
  const run = await waitStatus(backend, view.key, 'running');
  (run.retry as any).begin();
  (run.retry as any).lastOutcome = 'error';
  (run.retry as any).exhausted = true;
  (run.retry as any).publish({ group: 4, phase: 'running' });
  backdate(run, 601_000);
  (backend as any).stuckScan();
  await new Promise(r => setTimeout(r, 300));
  // 重试链判为中间态（排下一组退避，组号在退避到点后才递增）：任务未结束，run 不得被拉直。
  expect((backend as any).active.get(view.key).view.status).toBe('running');
  expect(run.view.retryGroup).toMatchObject({ group: 4, phase: 'waiting' });
  expect(run.view.retryGroup?.delayMs).toBeGreaterThan(0);
  expect((run.retry as any).active).toBe(true);
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

/** 把结算确认 RPC 打桩：settle 调用按脚本回放，其余走真 client。 */
const stubSettle = (run: any, script: Array<'reject' | 'resolve'>) => {
  const original = run.client.request.bind(run.client);
  let i = 0;
  run.client.request = async (method: string, params: any, timeout: number) => {
    if (String(params?.message ?? '').includes('-settle')) {
      const step = script[Math.min(i++, script.length - 1)];
      if (step === 'reject') { await new Promise(r => setTimeout(r, 30)); throw new Error('simulated settle timeout'); }
      await new Promise(r => setTimeout(r, 30));
      return {};
    }
    return original(method, params, timeout);
  };
};
/** 注入扩展的安全空闲回执（真实链路：setStatus desktop-retry-settled）。 */
const injectSettled = (backend: PiBackend, run: any) => {
  (backend as any).onEvent(run, { type: 'extension_ui_request', id: `t-${Math.random()}`, method: 'setStatus', statusKey: 'desktop-retry-settled', statusText: JSON.stringify({ generation: run.view.generation, token: run.settlement?.token }) });
};

it('结算确认回执丢失：自动重发确认命令（同 token 幂等），第二次回执到达即正常续接不降级', async () => {
  const { backend } = setup();
  const view = await backend.connect({ cwd: process.cwd(), trustProject: false, permission: 'ask' });
  await backend.prompt(view.key, '/stuck', 'followUp');
  const run = await waitStatus(backend, view.key, 'running');
  run.retryReady = true;
  (run.retry as any).begin();
  (run.retry as any).lastOutcome = 'stop'; // 真实链路：结算发生在任务自然完成后
  stubSettle(run, ['reject', 'resolve']);
  (backend as any).ensureSettlement(run);
  // 第一次探测失败（打桩 reject）→ 5s 后第二次探测 → 回执到达 → 清结算，不进 failed。
  await new Promise(r => setTimeout(r, 5_600));
  injectSettled(backend, run);
  await new Promise(r => setTimeout(r, 200));
  expect(run.settlement).toBeUndefined();
  expect(run.retryUncertain).toBe(false);
  expect((run.retry as any).state?.phase).not.toBe('failed');
  expect(run.view.error).toBeUndefined();
}, 20_000);

it('结算确认三次仍无回执：约 45s 窗口后降级手动恢复，错误文案可执行', async () => {
  const { backend } = setup();
  const view = await backend.connect({ cwd: process.cwd(), trustProject: false, permission: 'ask' });
  await backend.prompt(view.key, '/stuck', 'followUp');
  const run = await waitStatus(backend, view.key, 'running');
  run.retryReady = true;
  (run.retry as any).begin();
  stubSettle(run, ['reject', 'reject', 'reject']);
  (backend as any).ensureSettlement(run);
  await vi.waitFor(() => {
    expect((run.retry as any).state?.phase).toBe('failed');
  }, { timeout: 15_000, interval: 200 });
  expect(run.retryUncertain).toBe(true);
  expect(String(run.view.error)).toContain('多次确认运行时空闲失败');
  expect(String(run.view.error)).toContain('重新发送');
}, 20_000);
