import { describe, expect, it } from 'vitest';
import { createDockBadge } from '../src/main/pi/dock-badge';

const setup = () => {
  const applied: string[] = [];
  const badge = createDockBadge(text => applied.push(text));
  return { badge, applied };
};

describe('createDockBadge', () => {
  it('counts two distinct background sessions', () => {
    const { badge, applied } = setup();
    badge.taskDone('s1', false);
    expect(applied).toEqual(['1']);
    badge.taskDone('s2', false);
    expect(applied).toEqual(['1', '2']);
    expect(badge.count()).toBe(2);
  });

  it('窗口聚焦时不加角标（用户已看见完成）', () => {
    const { badge, applied } = setup();
    badge.taskDone('s1', true);
    expect(applied).toEqual([]);
    expect(badge.count()).toBe(0);
  });

  it('keeps one unread task after 65 completions in the same background session', () => {
    const { badge, applied } = setup();
    for (let i = 0; i < 65; i++) {
      badge.taskDone('s1', false, 1_000_000 + i * 6_000);
    }
    expect(badge.count()).toBe(1);
    expect(applied).toEqual(['1']);
  });

  it('counts separate sessions once each when their completions interleave', () => {
    const { badge, applied } = setup();
    const t = 1_000_000;
    badge.taskDone('s1', false, t);
    badge.taskDone('s2', false, t + 1_000);
    badge.taskDone('s1', false, t + 2_000);
    badge.taskDone('s2', false, t + 8_000);
    expect(badge.count()).toBe(2);
    expect(applied).toEqual(['1', '2']);
  });

  it('回到窗口 clear 清零；重复 clear 不重复下发', () => {
    const { badge, applied } = setup();
    badge.taskDone('s1', false);
    badge.clear();
    expect(applied).toEqual(['1', '']);
    badge.clear();
    expect(applied).toEqual(['1', '']);
    expect(badge.count()).toBe(0);
    badge.taskDone('s1', false);
    expect(applied).toEqual(['1', '', '1']);
  });

  it('聚焦完成后的去重窗口同样生效（合成信号不触发后续计数）', () => {
    const { badge, applied } = setup();
    const t = 1_000_000;
    badge.taskDone('s1', true, t); // 聚焦时完成：不计，但记录去重锚点
    badge.taskDone('s1', false, t + 2_000); // 短窗内合成 settled：跳过
    expect(applied).toEqual([]);
  });
});
