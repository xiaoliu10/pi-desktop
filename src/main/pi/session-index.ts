import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { PiEntry, PiHistory, PiSession } from '../../shared/pi';
const MAX_SESSION = 64 * 1024 * 1024;
/** 大于该值的会话文件变更时只更新元数据、延后全量解析：流式期间活动会话每个 delta
 * 都在追加，若每次 watch/轮询都重读重解析整个 MB 级文件，主进程会被持续拖死。 */
const DEFER_PARSE_BYTES = 256 * 1024;
export function canonical(file: string): string { try { return fs.realpathSync(file); } catch { try { return path.join(fs.realpathSync(path.dirname(file)), path.basename(file)); } catch { return path.resolve(file); } } }
export const fileKey = (file: string) => createHash('sha256').update(canonical(file)).digest('hex');
export function branchEntries(entries: PiEntry[], leaf?: string): PiEntry[] {
  const byId = new Map(entries.filter(e => e.id).map(e => [e.id!, e]));
  let current = leaf ? byId.get(leaf) : entries.at(-1);
  const out: PiEntry[] = [], seen = new Set<string>();
  while (current) {
    if (current.id && seen.has(current.id)) break;
    if (current.id) seen.add(current.id);
    out.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return out.reverse();
}
export class SessionIndex {
  private cache = new Map<string, { stamp: string; history: PiHistory }>();
  /** 已有缓存但文件又增长了的会话：等写入平息后再全量重解析。 */
  private dirty = new Map<string, string>();
  private settleTimer?: ReturnType<typeof setTimeout>;
  private timer?: ReturnType<typeof setInterval>;
  private watchers: fs.FSWatcher[] = [];
  private debounce?: ReturnType<typeof setTimeout>;
  constructor(public roots: string[], private readonly ownedRoot: string) {}
  private stampOf(file: string): { stat: fs.Stats; stamp: string } | undefined {
    try {
      const stat = fs.statSync(file);
      return { stat, stamp: `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` };
    } catch { return undefined; }
  }
  private parseFile(file: string, key: string): void {
    const stamped = this.stampOf(file);
    if (!stamped) return;
    const { stat, stamp } = stamped;
    if (stat.size > MAX_SESSION) throw new Error('会话超过 64 MiB 读取上限');
    const raw = fs.readFileSync(file, 'utf8');
    const lines = raw.split('\n');
    const tail = lines.pop(); // Never consume an incomplete append.
    const parsed: PiEntry[] = [], warnings: string[] = [];
    if (tail?.trim()) warnings.push('尾行尚未完整写入，等待同步。');
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      try { const e = JSON.parse(lines[i]); if (e && typeof e.type === 'string') parsed.push(e); else warnings.push(`第 ${i + 1} 行格式无效`); }
      catch { warnings.push(`第 ${i + 1} 行损坏，已跳过`); }
    }
    const header = parsed[0];
    if (header?.type !== 'session' || typeof header.id !== 'string' || typeof header.cwd !== 'string') { this.cache.delete(key); return; }
    const entries = parsed.slice(1), branch = branchEntries(entries);
    const first = entries.find(e => e.type === 'message' && e.message?.role === 'user')?.message?.content;
    const title = typeof first === 'string' ? first : Array.isArray(first) ? first.filter(b => b.type === 'text').map(b => b.text).join(' ') : '';
    const name = [...entries].reverse().find(e => e.type === 'session_info' && typeof e.name === 'string')?.name;
    const parents = new Set(entries.map(e => e.parentId));
    const session: PiSession = { key, id: header.id, path: file, cwd: header.cwd, name: String(name || title || '未命名 pi 会话').slice(0, 180), updatedAt: stat.mtimeMs, size: stat.size, warnings, owned: file.startsWith(canonical(this.ownedRoot) + path.sep), parentSession: typeof header.parentSession === 'string' ? header.parentSession : undefined };
    this.cache.set(key, { stamp, history: { session, entries, branch, leaves: entries.filter(e => e.id && !parents.has(e.id)).map(e => e.id!), leafId: branch.at(-1)?.id || null, syncedAt: Date.now() } });
    this.dirty.delete(key);
  }
  /** 文件写入平息 1.5s 后再重解析脏会话（流式追加是连续的，只有间隙才安全）。 */
  private scheduleSettle(changed?: () => void) {
    clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      if (!this.dirty.size) return;
      for (const [key, file] of this.dirty) {
        try { this.parseFile(file, key); } catch { /* 保留旧缓存，下次轮询重试 */ }
      }
      changed?.();
    }, 1500);
  }
  scan(): PiSession[] {
    const files = new Set<string>();
    const walk = (dir: string, depth = 0) => {
      if (depth > 8) return;
      try { for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, item.name);
        if (item.isSymbolicLink()) continue;
        if (item.isDirectory()) walk(full, depth + 1);
        else if (item.isFile() && item.name.endsWith('.jsonl')) files.add(fs.realpathSync(full));
      } } catch { /* A missing/unreadable directory does not hide the others. */ }
    };
    this.roots.forEach(root => walk(root));
    for (const [key, { history }] of this.cache) if (!files.has(history.session.path)) this.cache.delete(key);
    for (const file of files) {
      const key = fileKey(file);
      try {
        const stamped = this.stampOf(file);
        if (!stamped) continue;
        const { stat, stamp } = stamped;
        const cached = this.cache.get(key);
        if (cached?.stamp === stamp) continue;
        if (cached && stat.size > DEFER_PARSE_BYTES) {
          // 大文件增长：只更新廉价元数据（列表显示用），全量解析延后到平息。
          cached.history.session.size = stat.size;
          cached.history.session.updatedAt = stat.mtimeMs;
          this.dirty.set(key, file);
          continue;
        }
        this.parseFile(file, key);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') { this.cache.delete(key); continue; }
        const old = this.cache.get(key);
        if (old) old.history.session.warnings = [(err as Error).message];
      }
    }
    return [...this.cache.values()].map(x => x.history.session).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  history(key: string, leaf?: string): PiHistory {
    this.scan();
    // 目标会话有未落地的脏数据时同步重解析该文件（只此一个），保证刷新拿到完整尾部。
    const dirtyFile = this.dirty.get(key);
    if (dirtyFile) { try { this.parseFile(dirtyFile, key); } catch { /* 保留旧缓存 */ } }
    const found = this.cache.get(key)?.history;
    if (!found) throw new Error('会话不存在、不可读或不在选定目录中。');
    if (leaf && !found.entries.some(e => e.id === leaf)) throw new Error('分支记录不存在');
    return leaf ? { ...found, branch: branchEntries(found.entries, leaf), leafId: leaf } : found;
  }
  start(changed: () => void) {
    this.close();
    const signature = (sessions: PiSession[]) => sessions.map(s => `${s.key}:${s.size}:${s.updatedAt}:${s.warnings?.length ?? 0}`).join('|');
    let last = signature(this.scan());
    const check = () => {
      try {
        const next = signature(this.scan());
        if (next !== last) { last = next; changed(); }
      } catch { /* retry on next poll */ }
      if (this.dirty.size) this.scheduleSettle(changed);
    };
    for (const root of this.roots) try { this.watchers.push(fs.watch(root, { recursive: true }, () => { clearTimeout(this.debounce); this.debounce = setTimeout(check, 120); })); } catch { /* Poll fallback includes new roots. */ }
    this.timer = setInterval(check, 1200); this.timer.unref();
  }
  close() { clearInterval(this.timer); clearTimeout(this.debounce); clearTimeout(this.settleTimer); this.watchers.forEach(w => w.close()); this.watchers = []; this.dirty.clear(); }
}
