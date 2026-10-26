import { defaultUrlTransform } from 'react-markdown';

/** react-markdown 默认把 file:// href 剥成空串（safeProtocol 白名单不含 file），
 *  交付文件链接因此「有下划线但点不开」；file:// 原样保留，其余走默认安全过滤。 */
export function markdownUrlTransform(url: string): string {
  return /^file:\/\//i.test(url) ? url : defaultUrlTransform(url);
}

/** file:// URL → 本地绝对路径；非 file 协议、远程主机或非法输入一律返回 null。 */
export function fileUrlToPath(href: string | undefined): string | null {
  if (!href || !/^file:\/\//i.test(href)) return null;
  try {
    const url = new URL(href);
    if (url.protocol !== 'file:') return null;
    // 不处理 file://host/... 远程共享：只认本机路径。
    if (url.hostname && url.hostname !== 'localhost') return null;
    // file:// / file:/// 没有实际目标路径，拒绝根路径占位。
    if (!url.pathname || url.pathname === '/') return null;
    let pathname = decodeURIComponent(url.pathname);
    if (!pathname || pathname.includes('\0')) return null;
    // Windows 盘符：file:///C:/... → C:/...
    if (/^\/[a-zA-Z]:[\\/]/.test(pathname)) pathname = pathname.slice(1);
    if (!pathname.startsWith('/') && !/^[a-zA-Z]:[\\/]/.test(pathname)) return null;
    return pathname;
  } catch {
    return null;
  }
}
