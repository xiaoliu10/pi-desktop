import { describe, expect, it, vi } from 'vitest';

// 埋点契约：报告必须能回答「卡在哪个阶段、慢的是不是打字」。
// node 环境无 DOM：先注入 window/PerformanceObserver，再动态 import 模块。
class FakeEntry { startTime: number; duration: number; processingStart: number; processingEnd: number; target: unknown;
  constructor(startTime: number, duration: number, delay: number, target: unknown) { this.startTime = startTime; this.duration = duration; this.processingStart = startTime + delay; this.processingEnd = this.processingStart + duration; this.target = target; } }

async function load() {
  const observers: { cb: (l: { getEntries: () => any[] }) => void; opts: any }[] = [];
  // 具名 class：TS 参数属性（constructor(private cb)）会让 push(this) 早于字段赋值，拿到空 cb。
  // stubGlobal：vitest 2 里直接给 globalThis.window 赋值无效（getter），必须 stub。
  class FakePO { cb: any; opts: any = {}; constructor(cb: any) { this.cb = cb; observers.push(this); } observe(opts: any) { this.opts = opts; } disconnect() {} }
  vi.stubGlobal('window', { PerformanceObserver: FakePO, requestAnimationFrame: () => 1 });
  vi.stubGlobal('PerformanceObserver', FakePO);
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.resetModules();
  const mod = await import('../src/renderer/perf-probe');
  mod.installPerfProbe();
  return { mod, observers };
}

describe('perf probe report', () => {
  it('groups input delay by target and long tasks by phase', async () => {
    const { mod, observers } = await load();
    expect(observers.length).toBe(2); // event + longtask

    const eventObs = observers.find(o => o.opts.type === 'event')!;
    const longObs = observers.find(o => o.opts.type === 'longtask')!;
    // 打字慢一次（120ms 排队），点击快一次：报告要按 target 分组
    eventObs.cb({ getEntries: () => [new FakeEntry(1000, 30, 120, { tagName: 'TEXTAREA' }), new FakeEntry(1100, 5, 10, { tagName: 'BUTTON' })] });
    // 长任务归因：history-ipc 阶段内 900ms + 未归因 60ms
    mod.startPhase('history-ipc');
    longObs.cb({ getEntries: () => [{ startTime: 1000, duration: 900 }] });
    mod.endPhase('history-ipc');
    longObs.cb({ getEntries: () => [{ startTime: 1200, duration: 60 }] });

    const text = mod.perfReport();
    expect(text).toContain('输入延迟报告');
    expect(text).toContain('text-input');
    expect(text).toContain('max=120ms');
    expect(text).toContain('history-ipc');
    expect(text).toContain('900ms');
    expect(text).toContain('未归因长任务: 1 / 2');
  });

  it('attributes long tasks that arrive after the phase ends (observer batching)', async () => {
    const { mod, observers } = await load();
    const longObs = observers.find(o => o.opts.type === 'longtask')!;
    // PerformanceObserver 回调是异步批量的：phase 已 end 之后条目才到。
    // 若按「当前 phase」归因会丢；按时间区间匹配必须仍算 history-ipc。
    // 时间基准必须与 performance.now() 一致（entry.startTime 用的就是它）
    mod.startPhase('history-ipc');
    const startedAt = performance.now(); // phase 进行中产生的长任务（await 内部）
    mod.endPhase('history-ipc');
    longObs.cb({ getEntries: () => [{ startTime: startedAt + 5, duration: 800 }] });
    const text = mod.perfReport();
    expect(text).toContain('history-ipc');
    expect(text).toContain('800ms');
    expect(text).toContain('未归因长任务: 0 / 1');
  });

  it('ignores inputs below the noise floor', async () => {
    const { mod, observers } = await load();
    const eventObs = observers.find(o => o.opts.type === 'event')!;
    eventObs.cb({ getEntries: () => [new FakeEntry(1000, 2, 3, { tagName: 'TEXTAREA' })] });
    expect(mod.perfReport()).toContain('输入延迟（processingStart-startTime，>8ms 采样）');
    expect(mod.perfReport()).not.toContain('text-input');
  });
});
