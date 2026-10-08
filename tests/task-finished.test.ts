import { describe, expect, it } from 'vitest';
import { taskFinished } from '../src/shared/automation';

// 已结束判定驱动完成态 UI（灰色卡片 +「已结束」徽标替换开关，同 ZCode）。
// 服务端在 once 触发/达上限/过截止时已把 enabled 置 false，nextRunAt 清空。
describe('taskFinished', () => {
  const base = { nextRunAt: undefined as number | undefined, maxRuns: undefined as number | undefined, runCount: 0, endAt: undefined as number | undefined };
  const now = 1_000_000;

  it('once 已触发（nextRunAt 清空）→ 已结束', () => {
    expect(taskFinished({ ...base, nextRunAt: undefined, runCount: 1 }, now)).toBe(true);
    expect(taskFinished({ ...base, nextRunAt: null as unknown as undefined, runCount: 1 }, now)).toBe(true);
  });

  it('仍有下次执行 → 未结束（含手动暂停的任务）', () => {
    expect(taskFinished({ ...base, nextRunAt: now + 60_000 }, now)).toBe(false);
  });

  it('达到执行次数上限 → 已结束；未达上限 → 未结束', () => {
    expect(taskFinished({ ...base, nextRunAt: now + 60_000, maxRuns: 3, runCount: 3 }, now)).toBe(true);
    expect(taskFinished({ ...base, nextRunAt: now + 60_000, maxRuns: 3, runCount: 2 }, now)).toBe(false);
  });

  it('过截止时间 → 已结束；未到期 → 未结束', () => {
    expect(taskFinished({ ...base, nextRunAt: now + 60_000, endAt: now - 1 }, now)).toBe(true);
    expect(taskFinished({ ...base, nextRunAt: now + 60_000, endAt: now + 60_000 }, now)).toBe(false);
  });
});
