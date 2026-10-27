import { defaultUrlTransform } from 'react-markdown';

const isFileUrl = (value: string) => /^file:\/\//i.test(value);

/** react-markdown 默认把 file:// href 剥成空串（safeProtocol 白名单不含 file），
 *  交付文件链接因此「有下划线但点不开」；file:// 原样保留，其余走默认安全过滤。
 *  file:/ 单斜杠等非标准形态不放行，与 fileUrlToPath 共用同一谓词。 */
export function markdownUrlTransform(url: string): string {
  return isFileUrl(url) ? url : defaultUrlTransform(url);
}

/** file:// URL → 本地绝对路径；非 file 协议、远程主机或非法输入一律返回 null。 */
export function fileUrlToPath(href: string | undefined): string | null {
  if (!href || !isFileUrl(href)) return null;
  try {
    const url = new URL(href);
    if (url.protocol !== 'file:') return null;
    // 不处理 file://host/... 远程共享：只认本机路径。
    if (url.hostname && url.hostname !== 'localhost') return null;
    // file:// / file:/// 没有实际目标路径，拒绝根路径占位。
    if (!url.pathname || url.pathname === '/') return null;
    const pathname = decodeURIComponent(url.pathname);
    if (!pathname || pathname.includes('\0')) return null;
    // 拒绝 UNC 远程共享：file:////host/share 的 hostname 为空、pathname 以 // 开头，
    // 会绕过上面的 host 校验；Windows 上 openPath('\\\\host\\share') 会发起 SMB 连接。
    if (pathname.startsWith('//') || pathname.startsWith('\\\\')) return null;
    // 拒绝编码过的目录穿越（%2e%2e），避免路径混淆。
    if (pathname.split('/').includes('..')) return null;
    // Windows 盘符：file:///C:/... → C:/...
    if (/^\/[a-zA-Z]:[\\/]/.test(pathname)) return pathname.slice(1);
    if (!pathname.startsWith('/') && !/^[a-zA-Z]:[\\/]/.test(pathname)) return null;
    return pathname;
  } catch {
    return null;
  }
}
