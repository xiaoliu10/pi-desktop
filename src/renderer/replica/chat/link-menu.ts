/**
 * 聊天外链的右键菜单：默认动作是「在侧栏浏览器打开」，可选项是「用系统浏览器打开」。
 *
 * 为什么用命令式 DOM 而不是 React 组件：菜单由一个鼠标事件即时触发，挂在
 * ChatMarkdown 组件树里要额外维护 openPos/openUrl 状态，且 memo 的 ChatMarkdown
 * 会因为菜单开关重渲染整段 markdown（大会话实测有数千段）。这里直接建一个
 * 定长节点的浮层，样式走 chat.css 的 .pi-linkmenu*，行为与 popovers.ts 一致
 * （点击外部 / Esc / 切视图统一关闭）。
 */
import { closeTransientPopovers, onCloseTransientPopovers } from '../popovers';
import { requestOpenInBrowser } from '../workbench/browser-events';

interface MenuOptions {
  x: number;
  y: number;
  url: string;
  zh: boolean;
}

let cleanup: (() => void) | null = null;

/** 关掉当前菜单（若有）。 */
export function closeLinkMenu(): void {
  cleanup?.();
  cleanup = null;
}

export function openLinkMenu({ x, y, url, zh }: MenuOptions): void {
  closeLinkMenu();
  const host = document.body;
  const menu = document.createElement('div');
  menu.className = 'pi-linkmenu';
  menu.setAttribute('role', 'menu');

  const mk = (label: string, action: () => void, primary: boolean) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `pi-linkmenu__item${primary ? ' pi-linkmenu__item--primary' : ''}`;
    item.setAttribute('role', 'menuitem');
    item.textContent = label;
    item.addEventListener('click', () => { closeLinkMenu(); action(); });
    return item;
  };

  menu.appendChild(mk(zh ? '在侧栏浏览器中打开' : 'Open in sidebar browser', () => {
    if (!requestOpenInBrowser(url)) window.open(url, '_blank');
  }, true));
  menu.appendChild(mk(zh ? '用系统浏览器打开' : 'Open in system browser', () => window.open(url, '_blank'), false));
  host.appendChild(menu);

  // 贴边修正：菜单默认出现在光标右下，超出视口则翻转。
  const rect = menu.getBoundingClientRect();
  const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  // 先广播收起其他浮层，再注册自己的订阅——否则 closeTransientPopovers 会让
  // 自己刚注册的 handler 立即把菜单关掉。
  closeTransientPopovers();

  const onPointer = (event: MouseEvent) => { if (!menu.contains(event.target as Node)) closeLinkMenu(); };
  const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); closeLinkMenu(); } };
  const offPopovers = onCloseTransientPopovers(closeLinkMenu);
  // 捕获阶段：菜单项自己的 click 先执行完（关闭 → 动作），外部点击直接收。
  window.addEventListener('mousedown', onPointer, true);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', closeLinkMenu);
  window.addEventListener('scroll', closeLinkMenu, true);

  cleanup = () => {
    menu.remove();
    offPopovers();
    window.removeEventListener('mousedown', onPointer, true);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', closeLinkMenu);
    window.removeEventListener('scroll', closeLinkMenu, true);
  };
}
