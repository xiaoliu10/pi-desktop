import type { MessagePart } from '../contracts';

// image part → URL。key = part.id + data 指纹（同 id 同 data 才复用；part 由 messageCache
// 按 entry.id 缓存 ⇒ id 稳定，但无 id 的 entry 走 `entry-${index}` 兜底、跨刷新会串位，
// 指纹挡住这类串图）。
// 为什么不是 data URL：base64 直接拼会让浏览器为每张图常驻「base64 字符串 + 解码位图」
// 两份（实测某大会话 117 张图共 195MB base64，位图再翻倍，渲染进程 RSS 3.5G、GC 常年
// 高压 = 打字卡的根因）；且模板串每拍渲染都新建一份等同大小的字符串，流式期间就是
// GB 级垃圾。blob URL 只留位图，base64 字符串转完即可回收。
//
// 生命周期用引用计数：acquire()（组件挂载）持有一票，release()（卸载）归还。被淘汰的
// URL 只在「无人持有」时立即 revoke；仍有人持有（已挂载的 <img>）就推迟到最后一票
// 归还——否则会出现 use-after-revoke：裂图且 memo 化的 turn 不重渲、不自愈。
// 无 createObjectURL 的环境（测试/SSR）退回 data URL（不可 revoke，随组件卸载自然回收）。

const CACHE_MAX = 256;

interface ImageUrlEntry {
  url: string;
  /** 当前挂载持有该 URL 的组件数。 */
  refs: number;
  /** 已淘汰（不在缓存里）但仍有持有者：最后一票归还时 revoke。 */
  evicted: boolean;
  /** data URL 无位图可释放，revoke 是 no-op（保守起见仍调用，浏览器会忽略）。 */
  blob: boolean;
}

const cache = new Map<string, ImageUrlEntry>();
const inFlight = new Set<string>();

function fingerprint(p: MessagePart & { kind: 'image' }): string {
  // 头尾各取一段 + 长度：足够区分「同 id 不同 data」，成本 O(1)（不扫全串）。
  const data = p.data;
  return `${p.id}\u0000${data.length}\u0000${data.slice(0, 16)}${data.slice(-16)}`;
}

function encode(p: MessagePart & { kind: 'image' }): { url: string; blob: boolean } {
  try {
    // base64 标准允许忽略空白：pi 序列化/换行的长块可能带 \n，atob 对含空白的串直接抛
    // InvalidCharacterError——那时整批图会静默降级成 data URL（每张常驻两份 + 每拍重拼），
    // 正是「图片预览看不到 + 越用越卡」的静默根因。先剥空白再解。
    const binary = atob(p.data.replace(/\s+/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return { url: URL.createObjectURL(new Blob([bytes], { type: p.mimeType })), blob: true };
  } catch {
    return { url: `data:${p.mimeType};base64,${p.data}`, blob: false };
  }
}

function revoke(entry: ImageUrlEntry): void {
  if (!entry.blob) return;
  try { URL.revokeObjectURL(entry.url); } catch { /* already dead */ }
}

/** 组件挂载时调用：返回可稳定用于 <img src> 的 URL。调用方必须配对的 release()。 */
export function acquireImageUrl(p: MessagePart & { kind: 'image' }): string {
  const key = fingerprint(p);
  const hit = cache.get(key);
  if (hit) { hit.refs += 1; return hit.url; }
  // 已淘汰但仍有持有者：同一张图重新挂载（如补载/重渲染）时复用，不重复编码。
  // inFlight 之外的历史条目不追踪——被淘汰后重新出现按新条目处理，旧 URL 由原持有者释放。
  const { url, blob } = encode(p);
  cache.set(key, { url, refs: 1, evicted: false, blob });
  if (cache.size > CACHE_MAX) evictOldest();
  return url;
}

/** 组件卸载时调用（必须与 acquire 配对）。最后一票归还时若条目已淘汰，立即 revoke。 */
export function releaseImageUrl(p: MessagePart & { kind: 'image' }): void {
  const key = fingerprint(p);
  const entry = cache.get(key);
  if (!entry) return;
  entry.refs -= 1;
  if (entry.refs > 0) return;
  if (entry.evicted) { cache.delete(key); revoke(entry); }
}

/**
 * 淘汰最老一半（Map 保插入序）。仍被持有的条目标记 evicted 但**保留在缓存里**：
 * release 时要能按 key 找到它才能归还最后一票并 revoke；直接 delete 会让持有中的
 * 条目永远找不到 ⇒ URL 泄漏（且重新挂载同一张图会重复编码一份位图）。
 * 无持有者的条目立即 revoke 并删除。
 */
function evictOldest(): void {
  let i = 0;
  const drop = cache.size >> 1;
  for (const [key, entry] of cache) {
    if (i++ >= drop) break;
    if (entry.refs <= 0) { cache.delete(key); revoke(entry); }
    else entry.evicted = true;
  }
}

/** 测试专用：清空缓存（不 revoke，避免测试里 revoke 未创建的 URL）。 */
export function __resetImageUrlCacheForTest(): void {
  cache.clear();
  inFlight.clear();
}
