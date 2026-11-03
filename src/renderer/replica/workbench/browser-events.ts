/**
 * 聊天链接 → 工作台浏览器 的打开通道。
 *
 * 为什么要「宿主钩子 + DOM 事件」两层：
 * - 宿主管生命周期：点链接时工作台可能还没打开过（BrowserPanel 尚未挂载），
 *   必须先 `setState({workbenchOpen:true, workbenchTab:'browser'})` 让它挂上；
 *   这一步在 pi 层（PiReplicaApp），replica 层不能 import 它。
 * - 面板管实例：BrowserPanel 挂载后订阅具体 URL，按「新增标签页」处理。
 *
 * 时序：requestOpenInBrowser() → 同步调宿主钩子（触发 React 状态更新）→ 同步
 * dispatchEvent（此时面板可能还没渲染完，由 host 在下一帧补投，见 pendingUrl）。
 */
import { closeTransientPopovers } from '../popovers';

export const OPEN_IN_BROWSER_EVENT = 'pi:open-in-browser';

export interface OpenInBrowserDetail {
  url: string;
}

type HostHook = () => void;
let hostHook: HostHook | null = null;

/**
 * pi 层注册「把工作台切到浏览器 tab」的宿主钩子。返回取消函数。
 * 未注册时（replica 单独渲染 / 测试环境）不报错，请求会退回系统浏览器。
 */
export function setBrowserHost(hook: HostHook | null): void {
  hostHook = hook;
}

/**
 * 请求在工作台浏览器里打开 URL。返回是否有人接。
 * 接单方把事件标记 preventDefault，调用方据返回值决定是否退回系统浏览器。
 */
export function requestOpenInBrowser(url: string): boolean {
  if (typeof window === 'undefined') return false;
  // 收起上下文 popover 等浮层，避免与即将打开的面板抢焦点。
  closeTransientPopovers();
  const hadHost = Boolean(hostHook);
  hostHook?.();
  const dispatch = () => {
    const event = new CustomEvent<OpenInBrowserDetail>(OPEN_IN_BROWSER_EVENT, { detail: { url }, cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  if (dispatch()) return true;
  // 首次点链接时 BrowserPanel 才刚被 React 排上渲染队列，同步 dispatch 无人接。
  // 有宿主钩子就说明「面板马上会挂上」，隔一帧补投；没有宿主则真正无接收方，
  // 由调用方退回系统浏览器。
  if (!hadHost) return false;
  window.setTimeout(() => { if (!dispatch()) window.open(url, '_blank'); }, 0);
  return true;
}

/** 在 BrowserPanel 侧订阅。返回取消订阅函数。 */
export function onOpenInBrowser(handler: (url: string) => void): () => void {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<OpenInBrowserDetail>).detail;
    if (!detail?.url) return;
    event.preventDefault();
    handler(detail.url);
  };
  window.addEventListener(OPEN_IN_BROWSER_EVENT, listener);
  return () => window.removeEventListener(OPEN_IN_BROWSER_EVENT, listener);
}
