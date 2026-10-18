/**
 * 会话大纲（轮次摘要）持久化缓存。
 *
 * 动机（用户 2026-10-18）：「对话框边上的摘要标题应该做一个全量的吧，这个摘要直接
 * 做一个持久化的，每次点开对话直接加载不需要每次都重建」。
 *
 * 为什么值得持久化：sessionOutline() 每次都要扫全量 entries 聚合（实测 8ms/355 轮，
 * 205MB 会话一次全量解析 400ms+）。这个结果只依赖「user 消息标题 + 工具数 + 图片
 * 标记」，会话不增长就不变——持久化后点开大会话是「读一个小 JSON」而不是「重扫 205MB」。
 *
 * 失效策略（正确性优先，宁肯多算一次不可返回过期数据）：
 *  - 缓存条目带 (size, mtimeMs, leafId)：三者与文件当前 stat 完全一致才命中
 *  - 任一不一致（增长/替换/截断）→ 当作未缓存，重新聚合后覆盖写
 *  - 文件被删 → close() 顺手删条目（下次 sessionOutline 走全新聚合）
 *
 * 存储：userData/outline-cache.json，形如 { version, items: { [fileKey]: Entry } }。
 * 单文件 + 整体读写：一个用户的会话数百个、大纲只存标题（每条 <200B），总体几百 KB，
 * 不值得上 sqlite；写盘防抖（见 scheduleFlush）避免流式期间每拍重写。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { PiOutlineItem } from '../../shared/pi';

interface CachedEntry {
  /** 会话文件的 (size, mtimeMs, leafId)：任一变化即失效。 */
  size: number;
  mtimeMs: number;
  leafId: string;
  turns: PiOutlineItem[];
}

interface CacheFile {
  version: 1;
  items: Record<string, CachedEntry>;
}

/** 单会话最多缓存多少章（防御性上限：异常文件不会把缓存撑爆）。 */
const MAX_TURNS_PER_SESSION = 2000;
/** 整个缓存文件的大小上限（超出走 LRU 淘汰最老一半，保持启动加载快）。 */
const MAX_CACHE_BYTES = 8 * 1024 * 1024;

export class OutlineCache {
  private items: Record<string, CachedEntry> = {};
  private loaded = false;
  private dirty = false;
  private flushTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly file: string) {}

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as CacheFile;
      if (parsed && parsed.version === 1 && parsed.items && typeof parsed.items === 'object') this.items = parsed.items;
    } catch { /* 首次运行/文件损坏：当作空缓存，后续聚合结果会覆盖重建 */ }
  }

  /** 命中返回 turns；未命中（或已失效）返回 undefined。 */
  get(fileKey: string, stat: { size: number; mtimeMs: number }, leafId: string | undefined): PiOutlineItem[] | undefined {
    this.load();
    const hit = this.items[fileKey];
    if (!hit) return undefined;
    if (hit.size !== stat.size || hit.mtimeMs !== stat.mtimeMs || hit.leafId !== (leafId ?? '')) return undefined;
    return hit.turns;
  }

  set(fileKey: string, stat: { size: number; mtimeMs: number }, leafId: string | undefined, turns: PiOutlineItem[]): void {
    this.load();
    this.items[fileKey] = { size: stat.size, mtimeMs: stat.mtimeMs, leafId: leafId ?? '', turns: turns.slice(0, MAX_TURNS_PER_SESSION) };
    this.dirty = true;
    this.scheduleFlush();
  }

  /** 会话文件消失：删条目（否则缓存会无限累积已删会话的大纲）。 */
  delete(fileKey: string): void {
    this.load();
    if (!this.items[fileKey]) return;
    delete this.items[fileKey];
    this.dirty = true;
    this.scheduleFlush();
  }

  /** 防抖写盘：流式期间 sessionOutline 可能每拍被调（开着地图面板时），
   *  500ms 内的多次 set 合并成一次写；进程退出前 flushNow 兜底。 */
  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => { this.flushTimer = undefined; this.flushNow(); }, 500);
  }

  flushNow(): void {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = undefined; }
    if (!this.dirty) return;
    this.dirty = false;
    try {
      this.trim();
      const tmp = `${this.file}.tmp`;
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, items: this.items } satisfies CacheFile));
      fs.renameSync(tmp, this.file); // 原子替换：写一半崩溃不会留下坏缓存
    } catch { /* 磁盘满/只读：缓存降级为纯内存（本次进程内仍有效） */ }
  }

  /** 体积控制：整体超限时淘汰「最老一半」——按条目在 items 里的插入序（JS 对象保序），
   *  后写入的排在后面，删前面即删最老。不按 LRU：大纲数据没有「访问热度」概念，
   *  只有「最近更新」概念（更新过的会话排到了后面）。 */
  private trim(): void {
    const keys = Object.keys(this.items);
    if (keys.length <= 1) return;
    const bytes = JSON.stringify(this.items).length;
    if (bytes <= MAX_CACHE_BYTES) return;
    for (const key of keys.slice(0, Math.floor(keys.length / 2))) delete this.items[key];
  }
}
