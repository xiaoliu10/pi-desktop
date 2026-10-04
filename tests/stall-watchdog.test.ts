import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createStallWatchdog, summarizeFailures } from '../extensions/desktop-subagent/stall-watchdog.mjs';

const failed = (agent = 'a', stderr = 'boom: 模型调用失败') => ({ agent, stopReason: 'error', stderr });
const ok = (agent = 'b') => ({ agent, stopReason: 'stop' });
const running = (agent = 'b') => ({ agent, stopReason: 'toolUse' });

describe('子代理失败停滞看门狗（timer 驱动 + 每次进度重置）', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('真停滞：单次失败 update 后再无任何进度，静默满宽限期即触发', async () => {
    const onStall = vi.fn();
    const wd = createStallWatchdog({ graceMs: 10_000, onStall });
    wd.observe([failed()]);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(onStall).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onStall).toHaveBeenCalledTimes(1);
    expect(wd.triggered).toBe(true);
    wd.dispose();
  });

  it('健康并行不误杀：运行中的 toolUse 不是终态，永不布防', async () => {
    const onStall = vi.fn();
    const wd = createStallWatchdog({ graceMs: 10_000, onStall });
    wd.observe([failed('a'), running('b')]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onStall).not.toHaveBeenCalled();
    wd.dispose();
  });

  it('重复终态快照重置计时器：每次匹配观察都重置，持续观察期间不触发', async () => {
    const onStall = vi.fn();
    const wd = createStallWatchdog({ graceMs: 10_000, onStall });
    for (let i = 0; i < 5; i += 1) {
      wd.observe([failed('a'), ok('b')]); // 每 9s 重复同一终态快照
      await vi.advanceTimersByTimeAsync(9_000);
    }
    expect(onStall).not.toHaveBeenCalled();
    wd.dispose();
  });

  it('失败后恢复正常（如重试成功）：布防被解除，不触发', async () => {
    const onStall = vi.fn();
    const wd = createStallWatchdog({ graceMs: 10_000, onStall });
    wd.observe([failed('a'), ok('b')]);
    await vi.advanceTimersByTimeAsync(5_000);
    wd.observe([ok('a'), ok('b')]); // a 重试成功，失败态消失
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onStall).not.toHaveBeenCalled();
    wd.dispose();
  });

  it('触发后幂等：后续 observe 不再布防', async () => {
    const onStall = vi.fn();
    const wd = createStallWatchdog({ graceMs: 10, onStall });
    wd.observe([failed()]);
    await vi.advanceTimersByTimeAsync(10);
    expect(onStall).toHaveBeenCalledTimes(1);
    wd.observe([failed()]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onStall).toHaveBeenCalledTimes(1);
    wd.dispose();
  });

  it('空/非数组 results 不布防', () => {
    const onStall = vi.fn();
    const wd = createStallWatchdog({ graceMs: 10, onStall });
    expect(wd.observe(undefined)).toBe(false);
    expect(wd.observe([])).toBe(false);
    wd.dispose();
  });
});

describe('summarizeFailures', () => {
  it('含 agent 名与 stderr 首行', () => {
    expect(summarizeFailures([{ agent: 'electron-pro', stopReason: 'error', stderr: 'line1\nline2' }]))
      .toBe('electron-pro: line1');
  });
  it('stderr 为空时回退到 stopReason', () => {
    expect(summarizeFailures([{ agent: 'a', stopReason: 'error', stderr: '' }])).toBe('a: stopReason=error');
    expect(summarizeFailures([{ agent: 'a', stopReason: 'aborted' }])).toBe('a: stopReason=aborted');
  });
  it('多失败用 ；拼接', () => {
    expect(summarizeFailures([
      { agent: 'a', stopReason: 'error', stderr: 'x' },
      { agent: 'b', stopReason: 'aborted', stderr: 'y' },
    ])).toBe('a: x；b: y');
  });
  it('agent 缺失回退 subagent', () => {
    expect(summarizeFailures([{ stopReason: 'error', stderr: 'z' }])).toBe('subagent: z');
  });
  it('超长 stderr 截断 160 字符', () => {
    const long = 'x'.repeat(200);
    expect(summarizeFailures([{ agent: 'a', stopReason: 'error', stderr: long }])).toHaveLength('a: '.length + 160);
  });
});
