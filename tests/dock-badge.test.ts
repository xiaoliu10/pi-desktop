// Dock 角标（ZCode 式任务完成提示）：后台完成 +1、回窗口清零、同会话短窗去重。
import { describe, expect, it } from 'vitest';
import { createDockBadge } from '../src/main/pi/dock-badge';

const setup = () => {
  const applied: string[] = [];
  const badge = createDockBadge(text => applied.push(text));
  return { badge, applied };
};

describe('createDockBadge', () => {
  it('任务完成且窗口不在前台：角标累计 +1', () => {
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

  it('同一会话 5 秒内的重复 settled 信号只计一次', () => {
    const { badge, applied } = setup();
    const t = 1_000_000;
    badge.taskDone('s1', false, t);
    badge.taskDone('s1', false, t + 3_000);
    expect(applied).toEqual(['1']);
    badge.taskDone('s1', false, t + 6_000); // 超出去重窗口，新一轮完成
    expect(applied).toEqual(['1', '2']);
  });

  it('不同会话不受去重影响', () => {
    const { badge, applied } = setup();
    const t = 1_000_000;
    badge.taskDone('s1', false, t);
    badge.taskDone('s2', false, t + 1_000);
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
    badge.taskDone('s2', false);
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
