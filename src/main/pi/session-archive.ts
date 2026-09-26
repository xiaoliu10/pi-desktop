import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
/** 归档索引条目：key 为会话文件 sha256，archivedAt 驱动「归档 N 天后自动删除」。 */
export interface ArchivedEntry { key: string; archivedAt: number }
/** Desktop-only metadata: native pi session files are never modified. */
export class SessionArchive {
  /**
   * @param resolveUpdatedAt 旧 string[] 索引迁移时的 archivedAt 兜底来源：
   * 能从会话索引拿到 updatedAt 就用，拿不到用当前时间。
   */
  constructor(private file: string, private resolveUpdatedAt?: (key: string) => number | undefined) {}
  private read(): { entries: ArchivedEntry[]; migrated: boolean } {
    if (!fs.existsSync(this.file)) return { entries: [], migrated: false };
    const value = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    if (!Array.isArray(value)) throw new Error('归档索引损坏，请先备份并检查归档配置。');
    // 向后兼容：旧格式是纯 key 字符串数组，读入即迁移为新格式（下次写回落盘新格式）。
    if (value.every(v => typeof v === 'string')) {
      const now = Date.now();
      const keys = [...new Set(value as string[])];
      return { entries: keys.map(key => ({ key, archivedAt: this.resolveUpdatedAt?.(key) ?? now })), migrated: keys.length > 0 };
    }
    if (value.some(v => !v || typeof v !== 'object' || Array.isArray(v)
      || typeof (v as ArchivedEntry).key !== 'string' || !(v as ArchivedEntry).key
      || typeof (v as ArchivedEntry).archivedAt !== 'number' || !Number.isFinite((v as ArchivedEntry).archivedAt) || (v as ArchivedEntry).archivedAt <= 0)) {
      throw new Error('归档索引损坏，请先备份并检查归档配置。');
    }
    const seen = new Map<string, ArchivedEntry>();
    for (const entry of value as ArchivedEntry[]) if (!seen.has(entry.key)) seen.set(entry.key, { key: entry.key, archivedAt: entry.archivedAt });
    return { entries: [...seen.values()], migrated: false };
  }
  private write(entries: ArchivedEntry[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = this.file + '.' + randomUUID() + '.tmp';
    try { fs.writeFileSync(temporary, JSON.stringify(entries), { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, this.file); }
    finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  /** 带时间戳的归档条目；旧格式索引在首次读取时迁移并立即落盘，保证 archivedAt 稳定。 */
  entries(): ArchivedEntry[] {
    const { entries, migrated } = this.read();
    if (migrated) this.write(entries);
    return entries;
  }
  /** 兼容旧调用方：只返回 key 列表。 */
  list(): string[] { return this.entries().map(entry => entry.key); }
  set(key: string, archived: boolean, busy = false): string[] {
    if (typeof key !== 'string' || !key || key.length > 512 || typeof archived !== 'boolean') throw new Error('归档参数无效');
    if (archived && busy) throw new Error('任务仍在运行或等待确认，请先停止任务再归档。');
    return this.setMany([key], archived);
  }
  setMany(values: string[], archived: boolean): string[] {
    if (!Array.isArray(values) || values.some(key => typeof key !== 'string' || !key || key.length > 512)) throw new Error('归档参数无效');
    const now = Date.now();
    const map = new Map(this.entries().map(entry => [entry.key, entry]));
    // 重新归档刷新 archivedAt（「未操作」计时从最近一次归档动作起算）；恢复则移除条目。
    values.forEach(key => archived ? map.set(key, { key, archivedAt: now }) : map.delete(key));
    this.write([...map.values()]);
    return [...map.keys()];
  }
  /** 删除会话后清理索引条目（不影响其它条目的 archivedAt）。 */
  remove(keys: string[]): string[] {
    if (!Array.isArray(keys) || keys.some(key => typeof key !== 'string' || !key)) throw new Error('归档参数无效');
    const drop = new Set(keys);
    const entries = this.entries().filter(entry => !drop.has(entry.key));
    this.write(entries);
    return entries.map(entry => entry.key);
  }
}
