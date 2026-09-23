import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { PiEntry, PiHistory, PiSession } from '../../shared/pi';
const MAX_SESSION = 64 * 1024 * 1024;
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
  private timer?: ReturnType<typeof setInterval>;
  private watchers: fs.FSWatcher[] = [];
  private debounce?: ReturnType<typeof setTimeout>;
  constructor(public roots: string[], private readonly ownedRoot: string) {}
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
        const stat = fs.statSync(file), stamp = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
        if (this.cache.get(key)?.stamp === stamp) continue;
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
        if (header?.type !== 'session' || typeof header.id !== 'string' || typeof header.cwd !== 'string') { this.cache.delete(key); continue; }
        const entries = parsed.slice(1), branch = branchEntries(entries);
        const first = entries.find(e => e.type === 'message' && e.message?.role === 'user')?.message?.content;
        const title = typeof first === 'string' ? first : Array.isArray(first) ? first.filter(b => b.type === 'text').map(b => b.text).join(' ') : '';
        const name = [...entries].reverse().find(e => e.type === 'session_info' && typeof e.name === 'string')?.name;
        const parents = new Set(entries.map(e => e.parentId));
        const session: PiSession = { key, id: header.id, path: file, cwd: header.cwd, name: String(name || title || '未命名 pi 会话').slice(0, 180), updatedAt: stat.mtimeMs, size: stat.size, warnings, owned: file.startsWith(canonical(this.ownedRoot) + path.sep), parentSession: typeof header.parentSession === 'string' ? header.parentSession : undefined };
        this.cache.set(key, { stamp, history: { session, entries, branch, leaves: entries.filter(e => e.id && !parents.has(e.id)).map(e => e.id!), leafId: branch.at(-1)?.id || null, syncedAt: Date.now() } });
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
    const found = this.cache.get(key)?.history;
    if (!found) throw new Error('会话不存在、不可读或不在选定目录中。');
    if (leaf && !found.entries.some(e => e.id === leaf)) throw new Error('分支记录不存在');
    return leaf ? { ...found, branch: branchEntries(found.entries, leaf), leafId: leaf } : found;
  }
  start(changed: () => void) {
    this.close();
    let signature = JSON.stringify(this.scan());
    const check = () => { try { const next = JSON.stringify(this.scan()); if (next !== signature) { signature = next; changed(); } } catch { /* retry on next poll */ } };
    for (const root of this.roots) try { this.watchers.push(fs.watch(root, { recursive: true }, () => { clearTimeout(this.debounce); this.debounce = setTimeout(check, 120); })); } catch { /* Poll fallback includes new roots. */ }
    this.timer = setInterval(check, 1200); this.timer.unref();
  }
  close() { clearInterval(this.timer); clearTimeout(this.debounce); this.watchers.forEach(w => w.close()); this.watchers = []; }
}
