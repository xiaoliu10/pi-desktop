import { describe, expect, it, vi } from 'vitest';
import { createStallWatchdog, summarizeFailures } from '../extensions/desktop-subagent/stall-watchdog.mjs';

const failed = (agent = 'a', stderr = 'boom: 模型调用失败') => ({ agent, stopReason: 'error', stderr });
const ok = (agent = 'b') => ({ agent, stopReason: 'stop' });
const running = (agent = 'b') => ({ agent, stopReason: 'toolUse' });

describe('子代理失败停滞看门狗（timer 驱动 + 每次进度重置）', () => {
  it('真停滞：单次失败 update 后再无任何进度，静默满宽限期即触发', async () => {
    vi.useFakeTimers();
    const onStall = vi.fn();
    const wd = createStallWatchdog({ graceMs: 10_000, onStall });
    wd.observe([failed()]);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(onStall).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onStall).toHaveBeenCalledTimes(1);
    expect(wd.triggered).toBe(true);
    wd.dispose();
    vi.useRealTimers();
  });

  it('健康并行不误杀：运行中的 toolUse 不是终态，永不布防', async () => {
    vi.useFakeTimers();
    const onStall = vi.fn();
    const wd = createStallWatchdog({ graceMs: 10_000, onStall });
    wd.observe([failed('a'), running('b')]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onStall).not.toHaveBeenCalled();
    wd.dispose();
    vi.useRealTimers();
  });

  it('sibling 慢但活着：每次进度到达都重置计时器，不会在 update 间隔误触发', async () => {
    vi.useFakeTimers();
    const onStall = vi.fn();
    const wd = createStallWatchdog({ graceMs: 10_000, onStall });
    wd.observe([failed('a'), ok('b')]);
    for (let i = 0; i < 5; i += 1) {
      await vi.advanceTimersByTimeAsync(9_000);
      wd.observe([failed('a'), ok('b')]); // b 每 9s 产出一次进度
    }
    expect(onStall).not.toHaveBeenCalled();
    wd.dispose();
    vi.useRealTimers();
  });

  it('失败后恢复正常（如重试成功）：布防被解除，不触发', async () => {
    vi.useFakeTimers();
    const onStall = vi.fn();
    const wd = createStallWatchdog({ graceMs: 10_000, onStall });
    wd.observe([failed('a'), ok('b')]);
    await vi.advanceTimersByTimeAsync(5_000);
    wd.observe([ok('a'), ok('b')]); // a 重试成功，失败态消失
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onStall).not.toHaveBeenCalled();
    wd.dispose();
    vi.useRealTimers();
  });

  it('触发后幂等：后续 observe 不再布防', async () => {
    vi.useFakeTimers();
    const onStall = vi.fn();
    const wd = createStallWatchdog({ graceMs: 10, onStall });
    wd.observe([failed()]);
    await vi.advanceTimersByTimeAsync(10);
    expect(onStall).toHaveBeenCalledTimes(1);
    wd.observe([failed()]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onStall).toHaveBeenCalledTimes(1);
    wd.dispose();
    vi.useRealTimers();
  });

  it('空/非数组 results 不布防', () => {
    const onStall = vi.fn();
    const wd = createStallWatchdog({ graceMs: 10, onStall });
    expect(wd.observe(undefined)).toBe(false);
    expect(wd.observe([])).toBe(false);
    wd.dispose();
  });

  it('失败摘要：含 agent 名与 stderr 首行', () => {
    const s = summarizeFailures([failed('electron-pro', 'line1\nline2'), ok()]);
    expect(s).toBe('electron-pro: line1');
  });
});
