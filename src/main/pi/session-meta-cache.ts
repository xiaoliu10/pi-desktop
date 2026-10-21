/**
 * 会话列表元数据持久化快照（项目 → 会话标题）。
 *
 * 动机（用户 2026-10-21）：「desktop 启动到会话加载进列表有延迟，只做
 * 项目→会话标题的 cache 就够了——列表本身只展示标题」。冷启动时 SessionIndex
 * 要对全部会话文件（实测 390 个 / 1.2GB）读全文 + JSON.parse + 分支回溯才算出
 * 标题，冷扫 6.7s。列表真正需要的只是每个会话一行元数据（标题/目录/时间/大小），
 * 总量百来 KB——持久化后启动先读快照秒出列表，后台只做 stat 校验与增量纠正。
 *
 * 为什么 stat 指纹足够可信：命中条件是 (ino, size, mtimeMs, ctimeMs) 与快照记录
 * 完全一致——字节级未变的文件不需要重新解析头部与全文。任一变化即回退全量解析
 * （见 SessionIndex.refreshOne），宁可多解析一次也不返回过期标题。文件被删由
 * 后台 walk 校正（快照条目消失）。快照文件损坏 → 整体丢弃回退冷扫，安全降级。
 *
 * 存储与写盘模式与 OutlineCache 一致：userData/session-meta.json 单文件、
 * 原子替换、防抖写、退出前 flushNow。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { PiSession } from '../../shared/pi';

export interface MetaEntry extends PiSession {
  /** 文件指纹 `${ino}:${size}:${mtimeMs}:${ctimeMs}`（与 SessionIndex 的 stamp 同构）。 */
  stamp: string;
}

interface CacheFile {
  version: 1;
  items: Record<string, MetaEntry>;
}

/** 快照文件大小上限：每条元数据约 300–500B，上千会话也不到 1MB；超限走 LRU 淘汰。 */
const MAX_CACHE_BYTES = 4 * 1024 * 1024;

export class SessionMetaCache {
  private items: Record<string, MetaEntry> = {};
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
    } catch { /* 首次运行/文件损坏：空快照，冷扫重建 */ }
  }

  /** 全部快照条目（启动时据此预填列表，不触盘解析会话内容）。 */
  all(): MetaEntry[] {
    this.load();
    return Object.values(this.items);
  }

  get(key: string): MetaEntry | undefined {
    this.load();
    return this.items[key];
  }

  /** 会话全量解析成功后 Upsert（带上最新指纹）。 */
  set(key: string, session: PiSession, stamp: string): void {
    this.load();
    const { ...rest } = session;
    this.items[key] = { ...rest, stamp };
    this.dirty = true;
    this.scheduleFlush();
  }

  delete(key: string): void {
    this.load();
    if (!this.items[key]) return;
    delete this.items[key];
    this.dirty = true;
    this.scheduleFlush();
  }

  /** 防抖写盘：流式期间多个会话接连解析，500ms 合并成一次写。 */
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
      fs.renameSync(tmp, this.file);
    } catch { /* 磁盘满/只读：本次进程内快照仍有效，只是不持久 */ }
  }

  /** 超限时按插入序淘汰最老一半（最近解析/更新的会话排在后面），与 OutlineCache 同策略。 */
  private trim(): void {
    const keys = Object.keys(this.items);
    if (keys.length <= 1) return;
    if (JSON.stringify(this.items).length <= MAX_CACHE_BYTES) return;
    for (const key of keys.slice(0, Math.floor(keys.length / 2))) delete this.items[key];
  }
}
