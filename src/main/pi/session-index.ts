import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { PiEntry, PiHistory, PiSession } from '../../shared/pi';
import { MAX_SESSION, OversizedSessionError, sessionStub } from './session-size';
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
/**
 * 从嵌套会话路径推断其宿主主会话文件：pi-subagents async 布局为
 * <root>/<主会话名>/<childId>/run-N/session.jsonl——路径中第一段等于某主会话目录名
 * （即根下存在同名 <主会话名>.jsonl）时，返回该主会话文件路径。
 */
function inferParentFromNestedPath(dir: string, rootReal: Set<string>, files: Map<string, string>): string | undefined {
  let cur = dir;
  for (;;) {
    const parent = path.dirname(cur);
    if (rootReal.has(parent)) {
      // cur 是根下的第一层目录（主会话专属目录）
      const candidate = path.join(parent, path.basename(cur) + '.jsonl');
      if (files.has(candidate)) return candidate;
      // Overlapping roots may contain a more distant owning session. Keep walking.
    }
    const next = path.dirname(cur);
    if (next === cur) return undefined;
    cur = next;
  }
}

export class SessionIndex {
  /** parsedBytes = 已完整消费的字节数（到最后一行完整行末尾）；pendingTail = 其后尚未成行的残留。
   *  大会话流式期间每次只追加几 KB，history() 对脏文件走增量 tail 解析（毫秒级），
   *  不再全量重读（实测 103MB 会话全量重解析 421ms，同步阻塞主进程）。 */
  private cache = new Map<string, { stamp: string; history: PiHistory; parsedBytes: number; pendingTail: string; parsedIno: number }>();
  /** 嵌套子会话（pi-subagents async 布局）文件 → 推断的主会话路径。 */
  private nestedParents = new Map<string, string>();
  /** 已有缓存但文件又增长了的会话：等写入平息后再全量重解析。 */
  private dirty = new Map<string, string>();
  private settleTimer?: ReturnType<typeof setTimeout>;
  private timer?: ReturnType<typeof setInterval>;
  private watchers: fs.FSWatcher[] = [];
  private debounce?: ReturnType<typeof setTimeout>;
  /** 超限降级缓存（只有元数据）：history() 据此拒绝全量读取。 */
  private oversized = new WeakSet<PiHistory>();
  constructor(public roots: string[], private readonly ownedRoot: string) {}
  private stampOf(file: string): { stat: fs.Stats; stamp: string } | undefined {
    try {
      const stat = fs.statSync(file);
      return { stat, stamp: `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` };
    } catch { return undefined; }
  }
  private parseFile(file: string, key: string, incremental = false): void {
    const stamped = this.stampOf(file);
    if (!stamped) return;
    const { stat, stamp } = stamped;
    if (stat.size > MAX_SESSION) throw new OversizedSessionError(file, stat.size);
    const cached = this.cache.get(key);
    // 增量门：仅在「同一 inode 且 size ≥ 已读偏移」时安全。文件替换（rename-replace，
    // 新 inode）或截断都会落回全量——此前仅比 size 曾把替换误判为追加并污染 stamp，
    // scan() 永不纠正（静默错误历史直到重启）。
    if (incremental && cached && stat.size >= cached.parsedBytes && stat.ino === cached.parsedIno) {
      this.parseAppends(file, key, stat, stamp, cached);
      return;
    }
    const buf = fs.readFileSync(file);
    const raw = buf.toString('utf8');
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
    const session: PiSession = { key, id: header.id, path: file, cwd: header.cwd, name: String(name || title || '未命名 pi 会话').slice(0, 180), updatedAt: stat.mtimeMs, size: stat.size, warnings, owned: file.startsWith(canonical(this.ownedRoot) + path.sep), parentSession: typeof header.parentSession === 'string' ? header.parentSession : this.nestedParents.get(file), sidecarOf: path.basename(file).startsWith('sidecar_') ? '' : undefined };
    // parsedBytes 停在最后一个 0x0A 字节处（行边界在 U+000A，不受撕裂多字节尾部
    // 解码成 U+FFFD 后 byteLength 计数错位的影响）；尾部残留行作为 pendingTail 待增量拼接。
    const parsedBytes = buf.lastIndexOf(0x0a) + 1;
    this.cache.set(key, { stamp, history: { session, entries, branch, leaves: entries.filter(e => e.id && !parents.has(e.id)).map(e => e.id!), leafId: branch.at(-1)?.id || null, syncedAt: Date.now() }, parsedBytes, pendingTail: tail ?? '', parsedIno: stat.ino });
    this.dirty.delete(key);
  }
  /** 增量消费 cached.parsedBytes 之后的新增字节。parsedBytes 是**已读偏移**（pendingTail
   *  的字节已包含在内）：下次从它继续读，text = pendingTail + 新 chunk，不会重读也不会漏。
   *  文件缩短/替换（stamp 变小）时回退全量。只读新增段，不重读旧内容——这是大会话流式
   *  期间 history() 从几百 ms 同步阻塞降到毫秒级的关键。有新增完整行时替换 history 对象
   *  （原契约：重解析返回新引用）；仅尾部未成行时只更新元数据，不换引用以免渲染抖动。 */
  private parseAppends(file: string, key: string, stat: fs.Stats, stamp: string, cached: { stamp: string; history: PiHistory; parsedBytes: number; pendingTail: string; parsedIno: number }): void {
    const { history, parsedBytes, pendingTail } = cached;
    if (stat.ino !== cached.parsedIno) { this.parseFile(file, key); return; } // 替换（新 inode）：全量
    if (stat.size < parsedBytes) { this.parseFile(file, key); return; } // 截断：全量
    if (stat.size === parsedBytes && stamp !== cached.stamp) { this.parseFile(file, key); return; } // 同尺寸原地改写：无法廉价判别内容，回退全量
    if (stat.size === parsedBytes) { cached.stamp = stamp; this.dirty.delete(key); return; } // append-only 契约下纯 mtime 变化
    const len = stat.size - parsedBytes;
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, len, parsedBytes); } finally { fs.closeSync(fd); }
    const lines = (pendingTail + buf.toString('utf8')).split('\n');
    const newTail = lines.pop() ?? '';
    const base = history.session.warnings.filter(w => !w.startsWith('增量段跳过') && w !== '尾行尚未完整写入，等待同步。');
    const added: PiEntry[] = [];
    let bad = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      try { const e = JSON.parse(line); if (e && typeof e.type === 'string') added.push(e); else bad++; }
      catch { bad++; }
    }
    // 坏行跨增量累计成单条可替换警告：既有提示（原契约，坏行内容永久损坏）又不随流式无限增长。
    const prevBad = history.session.warnings.reduce((n, w) => n + (Number(/^增量段跳过 (\d+) 行损坏$/.exec(w)?.[1]) || 0), 0);
    const warnings = [...base, ...(prevBad + bad ? [`增量段跳过 ${prevBad + bad} 行损坏`] : [])];
    cached.stamp = stamp;
    cached.parsedBytes = parsedBytes + len;
    cached.pendingTail = newTail;
    if (!added.length) {
      // 只有未成行的尾部变化：元数据就地更新，history 引用不变。
      history.session.size = stat.size;
      history.session.updatedAt = stat.mtimeMs;
      history.session.warnings = warnings;
      return;
    }
    // 会话头只出现在首行，增量段不会引入 header；session_info 改名也能增量生效。
    const entries = [...history.entries, ...added];
    const branch = branchEntries(entries);
    const parents = new Set(entries.map(e => e.parentId));
    const name = [...added].reverse().find(e => e.type === 'session_info' && typeof e.name === 'string')?.name;
    // 增量路径也要派生标题（全量时 entries 为空、首条 user 晚到）：header-only 首扫后
    // 首条 user 经增量落地，不能让快流式会话一直叫「未命名 pi 会话」。
    let derived: string | undefined = typeof name === 'string' ? name : undefined;
    if (!derived && history.session.name === '未命名 pi 会话') {
      const firstUser = added.find(e => e.type === 'message' && e.message?.role === 'user')?.message?.content as unknown;
      const title = typeof firstUser === 'string' ? firstUser : Array.isArray(firstUser) ? firstUser.filter((b: any) => b.type === 'text').map((b: any) => String(b.text)).join(' ') : '';
      if (title) derived = title;
    }
    cached.history = {
      ...history,
      session: { ...history.session, size: stat.size, updatedAt: stat.mtimeMs, warnings, ...(derived ? { name: String(derived).slice(0, 180) } : {}) },
      entries,
      branch,
      leaves: entries.filter(e => e.id && !parents.has(e.id)).map(e => e.id!),
      leafId: branch.at(-1)?.id || history.leafId,
      syncedAt: Date.now(),
    };
    this.dirty.delete(key);
  }
  /** 文件写入平息 1.5s 后再重解析脏会话（流式追加是连续的，只有间隙才安全）。 */
  private scheduleSettle(changed?: () => void) {
    clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      if (!this.dirty.size) return;
      for (const [key, file] of this.dirty) {
        try { this.parseFile(file, key, true); } catch { /* 保留旧缓存，下次轮询重试 */ }
      }
      changed?.();
    }, 1500);
  }
  scan(includeSidecars = false): PiSession[] {
    const files = new Map<string, string>();
    const walk = (dir: string, depth = 0) => {
      if (depth > 8) return;
      let real: string;
      try { real = fs.realpathSync(dir); } catch { return; }
      try { for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, item.name);
        if (item.isSymbolicLink()) continue;
        if (item.isDirectory()) walk(full, depth + 1);
        else if (item.isFile() && item.name.endsWith('.jsonl')) files.set(fs.realpathSync(full), real);
      } } catch { /* A missing/unreadable directory does not hide the others. */ }
    };
    this.roots.forEach(root => walk(root));
    // pi-subagents ≥0.78 的 async 子会话落在 <主会话目录>/<childId>/run-N/session.jsonl，
    // 头部没有 parentSession/sidecarOf 标记 → 递归扫描会把它当独立会话收进侧栏/远控。
    // 按路径判定：凡不在会话根目录顶层、且位于某个主会话专属目录下的，推回其父主会话标记
    // （侧栏与远控的既有 parentSession 过滤随即生效）。
    const rootReal = new Set(this.roots.map(r => { try { return canonical(r); } catch { return r; } }));
    const previousParents = new Map(this.nestedParents);
    this.nestedParents.clear();
    for (const [file, dir] of files) {
      const parent = inferParentFromNestedPath(dir, rootReal, files);
      if (parent) this.nestedParents.set(file, parent);
    }
    for (const [key, { history }] of this.cache) {
      const file = history.session.path;
      // Parent creation/removal changes visibility even when the child file itself is unchanged.
      if (!files.has(file) || previousParents.get(file) !== this.nestedParents.get(file)) {
        this.cache.delete(key);
        this.dirty.delete(key);
      }
    }
    for (const file of files.keys()) {
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
        if (err instanceof OversizedSessionError) {
          // 超限会话降级为「元数据可见」：列表/侧栏照常显示（此前整个会话从侧栏消失，
          // 用户看到「该项目还没有会话」——96MB ashare 主会话 2026-10-09 的真实事故）。
          const stub = sessionStub(file);
          const stamped = this.stampOf(file); // 包裹 ENOENT：文件被并发删除时安全跳过（P2）
          if (!stub || !stamped) continue;
          const { stat, stamp } = stamped;
          const degraded = {
            session: { key, id: String(stub.header.id ?? key), path: file, cwd: String(stub.header.cwd ?? path.dirname(file)), name: String(stub.firstUserText || '未命名 pi 会话').slice(0, 180), updatedAt: stat.mtimeMs, size: stat.size, warnings: [err.message], owned: file.startsWith(canonical(this.ownedRoot) + path.sep), parentSession: typeof stub.header.parentSession === 'string' ? stub.header.parentSession : this.nestedParents.get(file), sidecarOf: path.basename(file).startsWith('sidecar_') ? '' : undefined },
            entries: [], branch: [], leaves: [], leafId: null, syncedAt: Date.now(),
          };
          this.oversized.add(degraded);
          // parsedBytes/pendingTail 对超限降级缓存无意义（永不增量解析），置 0/空满足类型。
          this.cache.set(key, { stamp, history: degraded, parsedBytes: 0, pendingTail: '', parsedIno: stat.ino });
          continue;
        }
        const old = this.cache.get(key);
        if (old) old.history.session.warnings = [(err as Error).message];
      }
    }
    return [...this.cache.values()].map(x => x.history.session).filter(s => includeSidecars || s.sidecarOf === undefined).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  /** Polling must not trigger a filesystem scan/reparse of every session. The
   * normal index watcher/history path owns refresh; expose only an indexed key. */
  subagentHistory(key: string, leaf?: string): PiHistory {
    const found = this.cache.get(key)?.history;
    if (!found || this.oversized.has(found)) throw new Error('Session unavailable');
    if (leaf && !found.entries.some(e => e.id === leaf)) throw new Error('Unknown leaf');
    return leaf ? { ...found, branch: branchEntries(found.entries, leaf), leafId: leaf } : found;
  }
  history(key: string, leaf?: string): PiHistory {
    // 快路径：缓存命中且目标文件 stamp 未变 → 直接增量消费尾部（若有新增）并返回。
    // 不再每次全扫 scan()（实测热扫也要 173ms，冷扫 3.5s——主进程同步阻塞是打字卡顿的
    // 第一根因）；新增/删除会话由 watcher/轮询的 changed() 驱动，单会话读取不依赖它。
    const fast = this.cache.get(key);
    if (fast) {
      const file = fast.history.session.path;
      const stamped = this.stampOf(file);
      if (stamped && stamped.stamp === fast.stamp) {
        if (stamped.stat.size > fast.parsedBytes || fast.pendingTail) {
          try { this.parseFile(file, key, true); } catch { /* 增量失败保留旧缓存 */ }
        }
        if (this.oversized.has(this.cache.get(key)!.history)) throw new OversizedSessionError(file, this.cache.get(key)!.history.session.size);
        return this.fromCache(key, leaf);
      }
      // stamp 变了（增长或截断替换）或文件消失：增长走增量，其余走慢路径清理。
      if (stamped && stamped.stat.size >= fast.parsedBytes) {
        try { this.parseFile(file, key, true); } catch (err) { if (err instanceof OversizedSessionError) throw err; }
        const updated = this.cache.get(key);
        if (updated && updated.stamp === stamped.stamp) return this.fromCache(key, leaf);
      }
    }
    this.scan();
    // 目标会话有未落地的脏数据时同步重解析该文件（只此一个），保证刷新拿到完整尾部。
    const dirtyFile = this.dirty.get(key);
    if (dirtyFile) { try { this.parseFile(dirtyFile, key, true); } catch { /* 保留旧缓存 */ } }
    return this.fromCache(key, leaf);
  }
  private fromCache(key: string, leaf?: string): PiHistory {
    const cached = this.cache.get(key)?.history;
    if (!cached) throw new Error('会话不存在、不可读或不在选定目录中。');
    // 超限会话只做了元数据降级：列表可见但全量历史不可读，给可执行错误而不是空历史。
    if (this.oversized.has(cached)) throw new OversizedSessionError(cached.session.path, cached.session.size);
    if (leaf && !cached.entries.some(e => e.id === leaf)) throw new Error('Unknown leaf');
    return leaf ? { ...cached, branch: branchEntries(cached.entries, leaf), leafId: leaf } : cached;
  }
  start(changed: () => void) {
    this.close();
    const signature = (sessions: PiSession[]) => sessions.map(s => `${s.key}:${s.size}:${s.updatedAt}:${s.warnings?.length ?? 0}`).join('|');
    let last = signature(this.scan(true));
    const check = () => {
      try {
        const next = signature(this.scan(true));
        if (next !== last) { last = next; changed(); }
      } catch { /* retry on next poll */ }
      if (this.dirty.size) this.scheduleSettle(changed);
    };
    for (const root of this.roots) try { this.watchers.push(fs.watch(root, { recursive: true }, () => { clearTimeout(this.debounce); this.debounce = setTimeout(check, 120); })); } catch { /* Poll fallback includes new roots. */ }
    this.timer = setInterval(check, 1200); this.timer.unref();
  }
  close() { clearInterval(this.timer); clearTimeout(this.debounce); clearTimeout(this.settleTimer); this.watchers.forEach(w => w.close()); this.watchers = []; this.dirty.clear(); }
}
