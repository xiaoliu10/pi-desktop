// 工作面板宽度上限（R-render-11）：随窗口宽度走，不再写死 700。
// 用户 2026-11-13 报「浏览器大小不对」：1920 宽窗口面板拖到 700 上限就到头，
// 桌面版网页（min-width 1000+）必然横向溢出。上限取 max(700, 60% 窗口宽)——
// 宽窗口显著放大给浏览器用，窄窗口保底 700 不把对话区挤没
// （≤1180px 时 workbench 本就切绝对定位浮层，不受该上限挤压）。
export function panelMaxForWindow(windowWidth: number): number {
  return Math.max(700, Math.round(windowWidth * 0.6));
}
