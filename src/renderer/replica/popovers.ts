/**
 * 瞬态浮层（上下文 popover / 记忆菜单 / 图片灯箱 / 项目菜单）的全局关闭信号。
 * 设置页是 z-60 的 fixed 覆盖层，主界面在其下仍完整渲染：任何 z 更高的 fixed
 * 浮层若在切换视图时还开着，会穿透到设置页上面吞掉点击与 hover（表现为
 * "菜单点不到、悬浮不变色"）。切视图前广播此事件统一收掉。
 */
export const CLOSE_POPOVERS_EVENT = 'pi:close-popovers';

export function closeTransientPopovers(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(CLOSE_POPOVERS_EVENT));
}

/** 瞬态浮层组件订阅用：事件到达即执行关闭回调。返回清理函数。 */
export function onCloseTransientPopovers(close: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = () => close();
  window.addEventListener(CLOSE_POPOVERS_EVENT, handler);
  return () => window.removeEventListener(CLOSE_POPOVERS_EVENT, handler);
}
