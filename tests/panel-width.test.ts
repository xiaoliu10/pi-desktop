// 工作面板宽度上限随窗口宽度走（用户 2026-11-13 报「浏览器大小不对」：
// 1920 宽窗口下工作面板拖到 700 上限就再也拉不宽，桌面版网页 min-width 1000+ 必然横向溢出）。
// 修复：上限 = max(700, 60% 窗口宽)；窗口缩小时回钳，避免把对话区挤没。
import { describe, expect, it } from 'vitest';
import { panelMaxForWindow } from '../src/renderer/replica/shell/panel-width';

describe('panelMaxForWindow', () => {
  it('宽窗口按 60% 放大（1920 → 1152，浏览器面板能容下桌面版网页）', () => {
    expect(panelMaxForWindow(1920)).toBe(1152);
  });

  it('1440 → 864，仍显著大于旧固定上限', () => {
    expect(panelMaxForWindow(1440)).toBe(864);
  });

  it('窄窗口保底 700，不小于旧上限（对话区不被挤没）', () => {
    expect(panelMaxForWindow(1000)).toBe(700);
    expect(panelMaxForWindow(800)).toBe(700);
  });

  it('非整数窗口宽取整', () => {
    expect(panelMaxForWindow(1921)).toBe(Math.max(700, Math.round(1921 * 0.6)));
  });
});
