import type { MessagePart } from '../contracts';

// image part → URL 的缓存。key = part.id（同 id 同 data；part 由 messageCache 按
// entry.id 缓存 ⇒ id 稳定）。优先 blob: URL——base64 直接拼 data URL 会让浏览器为每张图
// 常驻「base64 字符串 + 解码位图」两份（实测某大会话 117 张图共 195MB base64，位图再翻倍，
// 渲染进程 RSS 3.5G、GC 常年高压 = 打字卡的根因）。blob URL 只留位图，base64 字符串转完
// 即可回收。无 createObjectURL 的环境（测试/SSR）退回 data URL。
const IMAGE_URL_CACHE_MAX = 256;
const imageUrlCache = new Map<string, string>();

export function imageDataUrl(p: MessagePart & { kind: 'image' }): string {
  const hit = imageUrlCache.get(p.id);
  if (hit !== undefined) return hit;
  let url: string;
  try {
    const binary = atob(p.data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    url = URL.createObjectURL(new Blob([bytes], { type: p.mimeType }));
  } catch {
    url = `data:${p.mimeType};base64,${p.data}`;
  }
  imageUrlCache.set(p.id, url);
  if (imageUrlCache.size > IMAGE_URL_CACHE_MAX) {
    // 超限淘汰最老一半（Map 保插入序）。被淘汰 URL 立即 revoke：位图随之释放。
    let i = 0;
    for (const [key, value] of imageUrlCache) {
      if (i++ >= IMAGE_URL_CACHE_MAX >> 1) break;
      imageUrlCache.delete(key);
      if (value.startsWith('blob:')) { try { URL.revokeObjectURL(value); } catch { /* already dead */ } }
    }
  }
  return url;
}
