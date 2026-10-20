import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { PiEntry, PiHistory, PiOutline, PiOutlineItem, PiSearchHit, PiSearchResult, PiSession } from '../../shared/pi';
import { OutlineCache } from './outline-cache';
import { MAX_SESSION, OversizedSessionError, sessionStub } from './session-size';
import { computeUsageStats, type UsageStats } from './usage-stats';
import { recoverSubagents, subagentChildTranscript } from './official-subagent';
import { historyWindow } from './history-window';
/** 大于该值的会话文件变更时只更新元数据、延后全量解析：流式期间活动会话每个 delta
 * 都在追加，若每次 watch/轮询都重读重解析整个 MB 级文件，主进程会被持续拖死。 */
const DEFER_PARSE_BYTES = 256 * 1024;
/** entry 消息的纯文本（搜索/摘要用）：text 块 + toolCall 参数 + toolResult 内容，封顶防巨型单块拖垮匹配。 */
function entryText(message: any): string {
  const cap = (t: unknown) => typeof t === 'string' ? (t.length > 20_000 ? t.slice(0, 20_000) : t) : '';
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const out: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text') out.push(cap(block.text));
    else if (block.type === 'thinking') out.push(cap(block.thinking));
    else if (block.type === 'toolCall') {
      // 只取定位性字段（command/path/pattern/query/url）：整包 JSON 会把源码噪声喂给搜索，
      // 命中的 preview 就变成代码行（实测「打字」命中一堆 if (e.key === ' ')，毫无可读性）。
      const a = block.arguments;
      if (a && typeof a === 'object') for (const k of ['command', 'path', 'pattern', 'query', 'url', 'file_path']) {
        const v = (a as Record<string, unknown>)[k];
        if (typeof v === 'string') out.push(`${k}: ${v.slice(0, 200)}`);
      }
    }
    else if (block.type === 'toolResult') {
      const c = block.content;
      if (typeof c === 'string') out.push(cap(c));
      else if (Array.isArray(c)) for (const b of c) if (b?.type === 'text') out.push(cap(b.text));
    }
  }
  return out.join('\n');
}

function entryHasImage(message: any): boolean {
  const content = message?.content;
  return Array.isArray(content) && content.some((b: any) => b?.type === 'image');
}

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
  /** parsedBytes = 已读字节偏移（pendingTail 的字节含在内）；pendingTail = 已读但尚未成行的原始字节。
   *  详见 parseAppends 注释。
   *  大会话流式期间每次只追加几 KB，history() 对脏文件走增量 tail 解析（毫秒级），
   *  不再全量重读（实测 103MB 会话全量重解析 421ms，同步阻塞主进程）。 */
  private cache = new Map<string, { stamp: string; history: PiHistory; parsedBytes: number; pendingTail: Buffer; parsedIno: number }>();
  /** 分支 memo：leaf 模式下每次 history() 都要从全量 entries 回溯分支（17609 条实测
   *  ~500ms）。entries 引用 + leaf 不变则复用——流式期间每拍都调 history()，这是
   *  主进程阻塞的第一根因（埋点报告 history-ipc 33 次共 17.6s）。 */
  private branchMemo = new Map<string, Map<string, { entries: PiEntry[]; branch: PiEntry[] }>>();
  /** 已成功读取、但没有有效 pi header 的内容（含未成行 header）。仅记当前文件 stamp，
   *  不记 I/O 错误；任何追加/改写/替换均重新识别，避免每次兜底扫描重读非 pi jsonl。 */
  private rejected = new Map<string, string>();
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
  /** watch 事件待处理路径（绝对路径，可能是文件/目录/已删除路径）。 */
  private pendingPaths = new Set<string>();
  /** 兜底计数：每 N 次 check 做一次全量 walk（纠正 watch 漏事件/新目录）。 */
  private checkCount = 0;
  /** root 级 watch 事件（filename 为空）：触发本轮浅层目录发现而非全量 scan。 */
  private pendingDirsScan = false;
  private lastShallowScan = 0;
  private lastStatSweep = 0;
  // per-key per-leaf：单槽版本在多会话/多 leaf 交替读（尾窗 + 补拉 + 搜索定位 + 切
  // 会话）时互相污染——增量前缀校验只比长度与引用，不同会话的 entries 数组长度相近
  // 时误判「前缀成立」，直接吃别处的 plan 或 undefined（用户 2026-10-19 反馈
  // 「计划有时有有时没有」的真根因）。leaf 数有界，引用变化天然失效。
  private planMemos = new Map<string, Map<PiEntry[], { entries: PiEntry[]; plan: import('../../shared/conversation-status').PlanItem[] | undefined; doneWithNewTurn?: boolean }>>();
  /** 会话文件 → 所属 root real path 的表：增量 check 用它免掉全量 walk。
   *  （scan() 全量时重建。） */
  private fileDirs = new Map<string, string>();
  /** 已知目录集合（全量 walk 时记录）：增量 check 对它们做顶层 readdir 以发现新
   *  文件（watch 失效时的轮询兜底），比全树递归便宜一个量级。 */
  private knownDirs = new Set<string>();
  constructor(public roots: string[], private readonly ownedRoot: string, private readonly outlines?: OutlineCache) {}
  private stampOf(file: string): { stat: fs.Stats; stamp: string } | undefined {
    try {
      const stat = fs.statSync(file);
      return { stat, stamp: `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` };
    } catch { return undefined; }
  }
  /** 内容失效/删除时所有派生缓存一起清理，尤其不能留下 dirty 旧历史或计划。 */
  private forgetSession(key: string): void {
    this.cache.delete(key);
    this.branchMemo.delete(key);
    this.planMemos.delete(key);
    this.outlines?.delete(key);
    this.dirty.delete(key);
  }
  private forgetFile(file: string): void {
    this.forgetSession(fileKey(file));
    this.rejected.delete(file);
    this.fileDirs.delete(file);
  }
  private parseFile(file: string, key: string, incremental = false): void {
    const stamped = this.stampOf(file);
    if (!stamped) return;
    const { stat, stamp } = stamped;
    if (this.rejected.get(file) === stamp) return;
    this.rejected.delete(file);
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
    // 按字节切行（\n = 0x0a 单字节，UTF-8 多字节序列不含它）：行内容最后统一解码，
    // 撕裂的多字节字符在增量补齐后才解码，不会经过 U+FFFD 丢失原始字节。
    const lines: Buffer[] = [];
    for (let start = 0, i = 0; i <= buf.length; i++) {
      // 与 split('\n') 语义一致：结尾的 \n 之后也产生一个（空）段，pop 掉的才是「未成行」。
      if (i === buf.length || buf[i] === 0x0a) { lines.push(buf.subarray(start, i)); start = i + 1; }
    }
    const tailBytes = lines.pop() ?? Buffer.alloc(0); // Never consume an incomplete append.
    const parsed: PiEntry[] = [], warnings: string[] = [];
    if (tailBytes.length) warnings.push('尾行尚未完整写入，等待同步。');
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i].toString('utf8');
      if (!text.trim()) continue;
      try { const e = JSON.parse(text); if (e && typeof e.type === 'string') parsed.push(e); else warnings.push(`第 ${i + 1} 行格式无效`); }
      catch { warnings.push(`第 ${i + 1} 行损坏，已跳过`); }
    }
    const header = parsed[0];
    if (header?.type !== 'session' || typeof header.id !== 'string' || typeof header.cwd !== 'string') {
      this.forgetSession(key);
      this.rejected.set(file, stamp);
      return;
    }
    const entries = parsed.slice(1), branch = branchEntries(entries);
    const first = entries.find(e => e.type === 'message' && e.message?.role === 'user')?.message?.content;
    const title = typeof first === 'string' ? first : Array.isArray(first) ? first.filter(b => b.type === 'text').map(b => b.text).join(' ') : '';
    const name = [...entries].reverse().find(e => e.type === 'session_info' && typeof e.name === 'string')?.name;
    const parents = new Set(entries.map(e => e.parentId));
    const session: PiSession = { key, id: header.id, path: file, cwd: header.cwd, name: String(name || title || '未命名 pi 会话').slice(0, 180), updatedAt: stat.mtimeMs, size: stat.size, warnings, owned: file.startsWith(canonical(this.ownedRoot) + path.sep), parentSession: typeof header.parentSession === 'string' ? header.parentSession : this.nestedParents.get(file), sidecarOf: path.basename(file).startsWith('sidecar_') ? '' : undefined };
    // parsedBytes = buf.length：全部字节已读；尾部未成行字节保存在 pendingTail（原始
    // Buffer，解码无损），增量时与新 chunk 拼接后再统一解码——撕裂多字节在字节层面
    // 补齐后才能正确解码，任何字符串层面的提前处理都会经 U+FFFD 永久丢字节。
    this.cache.set(key, { stamp, history: { session, entries, branch, leaves: entries.filter(e => e.id && !parents.has(e.id)).map(e => e.id!), leafId: branch.at(-1)?.id || null, syncedAt: Date.now() }, parsedBytes: buf.length, pendingTail: Buffer.from(tailBytes), parsedIno: stat.ino });
    this.dirty.delete(key);
  }
  /** 增量消费 cached.parsedBytes 之后的新增字节。parsedBytes 是**已读偏移**（pendingTail
   *  的字节已包含在内）：下次从它继续读，text = pendingTail + 新 chunk，不会重读也不会漏。
   *  文件缩短/替换（stamp 变小）时回退全量。只读新增段，不重读旧内容——这是大会话流式
   *  期间 history() 从几百 ms 同步阻塞降到毫秒级的关键。有新增完整行时替换 history 对象
   *  （原契约：重解析返回新引用）；仅尾部未成行时只更新元数据，不换引用以免渲染抖动。 */
  private parseAppends(file: string, key: string, stat: fs.Stats, stamp: string, cached: { stamp: string; history: PiHistory; parsedBytes: number; pendingTail: Buffer; parsedIno: number }): void {
    const { history, parsedBytes, pendingTail } = cached;
    if (stat.ino !== cached.parsedIno) { this.parseFile(file, key); return; } // 替换（新 inode）：全量
    if (stat.size < parsedBytes) { this.parseFile(file, key); return; } // 截断：全量
    if (stat.size === parsedBytes && stamp !== cached.stamp) { this.parseFile(file, key); return; } // 同尺寸原地改写：无法廉价判别内容，回退全量
    if (stat.size === parsedBytes) { cached.stamp = stamp; this.dirty.delete(key); return; } // append-only 契约下纯 mtime 变化
    const len = stat.size - parsedBytes;
    const chunk = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, chunk, 0, len, parsedBytes); } finally { fs.closeSync(fd); }
    const whole = Buffer.concat([pendingTail, chunk]);
    const lines: Buffer[] = [];
    for (let start = 0, i = 0; i <= whole.length; i++) {
      if (i === whole.length || whole[i] === 0x0a) { lines.push(whole.subarray(start, i)); start = i + 1; }
    }
    const newTail = lines.pop() ?? Buffer.alloc(0);
    const base = history.session.warnings.filter(w => !w.startsWith('增量段跳过') && w !== '尾行尚未完整写入，等待同步。');
    const added: PiEntry[] = [];
    let bad = 0;
    for (const line of lines) {
      const text = line.toString('utf8');
      if (!text.trim()) continue;
      try { const e = JSON.parse(text); if (e && typeof e.type === 'string') added.push(e); else bad++; }
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
    // 流式追加占每次 history() 的大头：若每次都 branchEntries 全量回溯（17609 条建
    // Map + 走链，实测 550ms），工具循环每轮 message_end 触发的刷新都会打满主线程
    // （埋点：history-ipc n=206 共 120s）。新增条目从旧 branch 尾部顺序链接时（流式
    // 追加的绝对多数形态），branch 就是 O(新增) 的数组拼接；只有分叉/换父才全量回溯。
    const oldBranch = history.branch;
    const oldTailId = oldBranch.at(-1)?.id;
    let sequential = added.length > 0 && added[0]!.parentId === oldTailId;
    if (sequential) for (let i = 1; i < added.length; i += 1) {
      if (added[i]!.parentId !== added[i - 1]!.id) { sequential = false; break; }
    }
    const branch = sequential ? [...oldBranch, ...added] : branchEntries(entries);
    // entries 引用已换：per-leaf memo 全部失效（尾 leaf 不走 memo，直接引用 cache.branch）
    this.branchMemo.delete(key);
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
      this.knownDirs.add(real);
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
        this.forgetSession(key);
      }
    }
    for (const file of this.fileDirs.keys()) {
      if (!files.has(file)) this.forgetFile(file);
    }
    // 全扫与 watch/check 共享同一 stamp/拒绝/错误处理，保留原全量发现与嵌套推断。
    this.fileDirs = files;
    for (const [file, dir] of files) this.refreshOne(file, dir);
    return [...this.cache.values()].map(x => x.history.session).filter(s => includeSidecars || s.sidecarOf === undefined).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  /** 会话列表视图：直接从 cache 构建（check 的增量维护保证新鲜）。IPC sessions
   *  handler 用它替代 scan()——流式期间 signature 每 120ms 变一次，每次都全量
   *  walk（244ms 同步）会让主进程持续满载、所有 IPC 排队（text-input 尖峰的
   *  排队 600ms 即由此来）。新文件/删除由 check 的增量路径维护进 cache。
   *  需要全量一致性的场景（启动、30 次兜底）仍走 scan()。 */
  sessionsView(includeSidecars = false): PiSession[] {
    return [...this.cache.values()].map(x => x.history.session).filter(s => includeSidecars || s.sidecarOf === undefined);
  }
  // ── IndexPort (see ./index-port) 的进程内实现 ────────────────────────────────
  // 主进程改由 utility process 持有时，同一套接口由 IndexWorkerClient 满足；本类在
  // 测试与非 Electron 调用方里直连文件系统，行为与历史实现逐字一致。
  /** 元数据查询。owner 侧（进程内 SessionIndex / worker）cache 未命中时做一次全量
   *  发现——与旧 history() 的慢路径逐字一致（新 fork 出的副本、watch 漏事件都靠它
   *  收口）；主进程的 IndexWorkerClient 覆写为纯镜像读，绝不触盘。 */
  sessionMeta(key: string): PiSession | undefined {
    const hit = this.cache.get(key)?.history.session;
    if (hit) return hit;
    this.scan();
    return this.cache.get(key)?.history.session;
  }
  /** 分支尾部 n 条：与旧 `history(key).branch.slice(-n)` 同口径——先增量消费文件尾部
   *  （history 的快路径：stat + 增量解析，毫秒级）再读缓存；超限/不存在同样抛错，
   *  调用方沿用原 try/catch fail-closed。owner 侧触盘，主进程只收到有界镜像。 */
  branchTail(key: string, n: number): PiEntry[] {
    const branch = this.history(key).branch;
    return n >= branch.length ? [...branch] : branch.slice(branch.length - n);
  }
  /** 事件时刻的 owner 读：与 branchTail 同口径（history() 快路径增量消费文件尾部），
   *  只是异步签名——跨进程时由 worker op 承载（见 index-worker-protocol）。 */
  async branchTailAsync(key: string, n: number): Promise<PiEntry[]> { return this.branchTail(key, n); }
  /** 用量统计在 owner 内聚合（按需读取文件）：主进程只收聚合结果，不做任何会话文件 IO。
   *  now 与 computeUsageStats 默认值一致（调用方可注入确定时钟）。 */
  async usageStatsAsync(now?: Date): Promise<UsageStats> { return computeUsageStats(this.scan(), now); }
  branchLength(key: string): number {
    const cached = this.cache.get(key)?.history;
    if (!cached) throw new Error('Session unavailable');
    return cached.branch.length;
  }
  async historyAsync(key: string, leaf?: string, opts?: { tail?: number; before?: string; count?: number }): Promise<PiHistory> { return this.history(key, leaf, opts); }
  async searchAsync(key: string, query: string, opts?: { limit?: number }): Promise<PiSearchResult> { return this.searchSession(key, query, opts); }
  async outlineAsync(key: string): Promise<PiOutline> { return this.sessionOutline(key); }
  async remotePage(key: string, before: string | null, page: number): Promise<{ branch: PiEntry[]; hasMore: boolean; before: number } | null> {
    // 与 worker remotePage op 同一实现（utility worker 之外的进程内 IndexPort 也要逐字
    // 一致）：history() 抛错（超限/不可读/会话不存在）时回 null，由 HTTP 层回 404。
    let history;
    try { history = this.history(key); } catch { return null; }
    const branch = history.branch ?? [];
    const win = historyWindow(branch.length, before, page);
    return { branch: branch.slice(win.start, win.end), hasMore: win.hasMore, before: win.start };
  }
  /** fork-to-continue 的无损副本：用缓存里已解析的全量 entries 按 backend 旧实现逐字
   *  相同的逐行 JSON 规则写出 Desktop 副本。原子落盘（tmp+rename），失败不留半文件。
   *  只在 worker 进程被调用——全量 entries 不得跨进程回主进程（见 index-worker-entry
   *  职责边界注释）。 */
  forkCopySource(key: string, targetPath: string, header: { id: string; timestamp: string; parentSession: string }): { path: string; entries: number } {
    const cached = this.cache.get(key)?.history;
    if (!cached) throw new Error('会话不存在、不可读或不在选定目录中。');
    if (this.oversized.has(cached)) throw new OversizedSessionError(cached.session.path, cached.session.size);
    // 与旧实现 fs.writeFileSync(targetPath, ..., { flag: 'wx' }) 语义一致：目标已存在
    // 必须原样抛 EEXIST，绝不覆盖。
    if (fs.existsSync(targetPath)) {
      const err = new Error(`EEXIST: file already exists, open '${targetPath}'`) as NodeJS.ErrnoException;
      err.code = 'EEXIST'; throw err;
    }
    // 原子落盘（tmp+rename）：写失败/进程被杀都不会留下半截目标文件；tmp 用 wx 防撞。
    const tmp = `${targetPath}.copy-tmp-${process.pid}-${Date.now()}`;
    const sourceHeader = JSON.parse(fs.readFileSync(cached.session.path, 'utf8').split('\n')[0] ?? '{}') as Record<string, unknown>;
    const payload = [
      JSON.stringify({ ...sourceHeader, id: header.id, timestamp: header.timestamp, parentSession: header.parentSession }),
      ...cached.entries.map(e => JSON.stringify(e)),
      '',
    ].join('\n');
    try {
      fs.writeFileSync(tmp, payload, { flag: 'wx', mode: 0o600 });
      fs.renameSync(tmp, targetPath);
    } catch (err) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* 失败时尽力清理临时文件 */ }
      throw err;
    }
    return { path: targetPath, entries: cached.entries.length };
  }
  async recoverSubagents(agentDir: string, key: string, leaf?: string, pinned?: string[], knownSignature?: string) { return recoverSubagents(agentDir, key, this, leaf, pinned, knownSignature); }
  async subagentChildTranscript(agentDir: string, key: string, callId: string, childId: string) { return subagentChildTranscript(agentDir, key, this, callId, childId); }
  async ready(): Promise<void> { /* 进程内：cache 在 start() 内同步就绪 */ }
  async subscribe(_key: string): Promise<void> { /* 进程内：无需镜像 */ }
  unsubscribe(_key: string): void { /* 进程内：无需镜像 */ }

  /** Polling must not trigger a filesystem scan/reparse of every session. The
   * normal index watcher/history path owns refresh; expose only an indexed key. */
  subagentHistory(key: string, leaf?: string): PiHistory {
    const found = this.cache.get(key)?.history;
    if (!found || this.oversized.has(found)) throw new Error('Session unavailable');
    if (leaf && !found.entries.some(e => e.id === leaf)) throw new Error('Unknown leaf');
    return leaf ? { ...found, branch: branchEntries(found.entries, leaf), leafId: leaf } : found;
  }
  /**
   * 会话内全文搜索：扫已解析的 entries（主进程持有全量，O(n) 字符串匹配，205MB 实测
   * <100ms），只回定位信息。索引不需要另建——entry 链表本身就是有序索引（稳定 id +
   * parentId），user 消息是天然的轮次边界。渲染层命中后走 history(before) 取回那段。
   * 只搜当前 branch（与渲染一致）；空 query 返回空（调用方负责拦截）。
   */
  searchSession(key: string, query: string, opts?: { limit?: number }): PiSearchResult {
    const cached = this.cache.get(key)?.history;
    if (!cached) return { total: 0, hits: [] };
    const needle = query.trim();
    if (!needle) return { total: 0, hits: [] };
    const limit = Math.max(1, Math.min(opts?.limit ?? 50, 200));
    const hits: PiSearchHit[] = [];
    let total = 0;
    let turnEntryId: string | undefined;
    const entries = cached.entries;
    for (const entry of entries) {
      const message = entry.message;
      if (message?.role === 'user' && entry.id) turnEntryId = entry.id;
      if (!message) continue;
      const text = entryText(message);
      if (!text || !text.includes(needle)) continue;
      total += 1;
      if (hits.length >= limit) continue;
      const at = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
      const cut = text.indexOf(needle);
      const preview = (cut > 60 ? `…${text.slice(cut - 60, cut + 140)}` : text.slice(0, 200)).replace(/\s+/g, ' ').trim();
      hits.push({ entryId: entry.id ?? '', role: String(message.role ?? ''), preview: preview.length > 200 ? `${preview.slice(0, 200)}…` : preview, at: Number.isFinite(at) ? at : 0, turnEntryId });
    }
    return { total, hits };
  }

  /** 会话大纲：每个 user entry 一章（title=首行截断，toolCount=该轮工具数，hasImages）。
   *  持久化缓存（outline-cache）：结果只随「user 标题/工具数/图片标记」变化，会话不增长
   *  就不变——点开大会话时读一个小 JSON 而不是重扫 205MB（用户 2026-10-18 要求）。
   *  失效 = (size, mtimeMs, leafId) 任一变化，宁肯多算一次不可返回过期数据。 */
  sessionOutline(key: string): PiOutline {
    // 先走一次 history() 的快路径：它负责「缓存未变则直接返回、变了则增量解析」。
    // 少了这一步，文件增长后 sessionOutline 会拿着 scan() 时的旧 entries 聚合——
    // 既是过期数据（正确性），也让持久化缓存永远命中旧 stamp（用户看到的大纲不更新）。
    // history() 已按 (entries 引用, leaf) memo，热路径 0.42ms，不会成为新瓶颈。
    try { this.history(key); } catch { /* 超限/暂时读取失败保留的缓存仍可聚合；无效/删除的不复活。 */ }
    const cached = this.cache.get(key)?.history;
    if (!cached) return { turns: [], total: 0 };
    const file = cached.session.path;
    const stamped = this.stampOf(file);
    const stat = stamped ? { size: stamped.stat.size, mtimeMs: stamped.stat.mtimeMs } : undefined;
    const leafId = cached.leafId ?? undefined;
    const fileKey = key; // SessionIndex 内部 key 即 fileKey(file)（host 用 index.scan() 的 key）
    if (this.outlines && stat) {
      const hit = this.outlines.get(fileKey, stat, leafId);
      if (hit) return { turns: hit, total: hit.length };
    }
    const turns: PiOutlineItem[] = [];
    let current: PiOutlineItem | undefined;
    for (const entry of cached.entries) {
      const message = entry.message;
      if (!message) continue;
      const at = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
      if (message.role === 'user' && entry.id) {
        current = { entryId: entry.id, title: entryText(message).slice(0, 80), at: Number.isFinite(at) ? at : 0, toolCount: 0, hasImages: entryHasImage(message) };
        turns.push(current);
        continue;
      }
      if (!current) continue;
      if (Array.isArray(message.content)) for (const block of message.content) {
        if (block?.type === 'toolCall') current.toolCount += 1;
        if (block?.type === 'image') current.hasImages = true;
      }
    }
    const page = turns.slice(-500);
    if (this.outlines && stat) this.outlines.set(fileKey, stat, leafId, page);
    return { turns: page, total: turns.length };
  }

  /**
   * 读取会话历史。opts.tail：只返回 branch 尾部 N 条（大会话分页首屏用）。
   * 动机：用户真实会话 201MB / 117 张图 / 195MB base64，全量序列化经 IPC 到渲染层
   * 每几秒一次，主进程被吃到 99% CPU（解析 + 结构化克隆双份常驻）。尾部窗口首屏 +
   * 按需补拉更早的页，把单次传输从「整个会话」降到「一屏」。
   * 语义：truncated 字段告知调用方还有多少条没给（renderer 据此显示「更早的消息」）。
   */
  history(key: string, leaf?: string, opts?: { tail?: number; before?: string; count?: number }): PiHistory {
    const __t0 = Date.now();
    try {
      return this.historyInner(key, leaf, opts);
    } finally {
      const __cost = Date.now() - __t0;
      if (__cost > 100) {
        // console.error 在 Finder 启动的 Electron 主进程不可见（im-log 教训）——落
        // main-perf.log，与 ipc 计时同文件，尖峰归因时直接对表。
        try {
          const { appendFileSync } = require('node:fs') as typeof import('node:fs');
          const { join } = require('node:path') as typeof import('node:path');
          const { homedir } = require('node:os') as typeof import('node:os');
          appendFileSync(join(homedir(), 'Library', 'Logs', 'PI Desktop', 'main-perf.log'), `${new Date().toISOString()} history key=${key.slice(0, 8)} tail=${opts?.tail ?? '-'} leaf=${leaf ? 'y' : 'n'} ${__cost}ms\n`);
        } catch { /* 观测不可用不影响主流程 */ }
      }
    }
  }

  private historyInner(key: string, leaf?: string, opts?: { tail?: number; before?: string; count?: number }): PiHistory {
    // 快路径：缓存命中且目标文件 stamp 未变 → 直接增量消费尾部（若有新增）并返回。
    // 不再每次全扫 scan()（实测热扫也要 173ms，冷扫 3.5s——主进程同步阻塞是打字卡顿的
    // 第一根因）；新增/删除会话由 watcher/轮询的 changed() 驱动，单会话读取不依赖它。
    const fast = this.cache.get(key);
    if (fast) {
      const file = fast.history.session.path;
      const stamped = this.stampOf(file);
      if (stamped && stamped.stamp === fast.stamp) {
        if (stamped.stat.size > fast.parsedBytes || fast.pendingTail.length) {
          try { this.parseFile(file, key, true); } catch { /* 增量失败保留旧缓存 */ }
        }
        if (this.oversized.has(this.cache.get(key)!.history)) throw new OversizedSessionError(file, this.cache.get(key)!.history.session.size);
        return this.fromCache(key, leaf, opts);
      }
      // stamp 变了（增长或截断替换）或文件消失：增长走增量，其余走慢路径清理。
      if (stamped && stamped.stat.size >= fast.parsedBytes) {
        try { this.parseFile(file, key, true); } catch (err) { if (err instanceof OversizedSessionError) throw err; }
        const updated = this.cache.get(key);
        if (updated && updated.stamp === stamped.stamp) return this.fromCache(key, leaf, opts);
      }
    }
    this.scan();
    // 目标会话有未落地的脏数据时同步重解析该文件（只此一个），保证刷新拿到完整尾部。
    const dirtyFile = this.dirty.get(key);
    if (dirtyFile) { try { this.parseFile(dirtyFile, key, true); } catch { /* 保留旧缓存 */ } }
    return this.fromCache(key, leaf, opts);
  }
  /** 分页模式的 IPC 瘦身：PiHistory.entries 全量（大会话 17609 条）每次 history()
   *  都过 IPC——主进程序列化 + renderer 反序列化各约 500ms（埋点：history-ipc 阶段
   *  avg 1202ms，text-input 尖峰 max 与 phase max 完全重合）。renderer 对 entries
   *  零消费（只用 branch/leaves/leafId/session，grep 2026-10-18 核实），分页模式下
   *  用 branch 顶替（类型合规），IPC 体积砍 ~97%。需要全量 entries 的调用方走
   *  主进程内部（cache 直读），不走 IPC 分页契约。 */
  private wireLite(key: string, full: PiHistory): PiHistory {
    // plan 扫全量 entries（branch 是分页裁切，可能只是尾部 500 条——若按 branch
    // 扫就会漏掉任务早期建的清单）。memo 键 = full.entries 引用：parseFile 增量
    // 解析换新数组才重算，静止/流式期间（每拍 refreshHistory）命中即零成本。
    // 注意：wireLite 的调用方传的是分页*之前*的 full，裁切只影响返回值。
    const plan = this.lastPlan(key, full.entries);
    // 对象身份契约：renderer 按 history 引用判断「有没有新内容」换 branch（流式
    // 每拍 IPC）。无 tail 且 plan 未变时必须原样返回 cached 引用，不能每次新建
    // 对象——那会让静止会话每拍都触发一次 renderer 冷重建（增量解析测试钉住）。
    if (!full.truncated && plan === full.plan && (full as any).plan !== undefined) return full;
    if (!full.truncated && plan === undefined && (full as any).plan === undefined) return full;
    return { ...full, entries: full.branch, plan };
  }

  /** 会话最后一次成功的 desktop_update_plan 清单：renderer 实时解析只看渲染窗口
   *  （tail 500），长任务把清单调用裁出窗口后「进程」区块就空了。主进程有全量
   *  branch，扫最后一次成功结果随 history 下发。O(n) 按 entries 引用 memo。 */
  private lastPlan(key: string, entries: PiEntry[]): import('../../shared/conversation-status').PlanItem[] | undefined {
    // 分槽：per-key 的 entries-引用 memo（key 内 per-leaf 由引用天然区分——不同 leaf
    // 的 branch 是不同的 entries 数组）。parseFile 增量换数组即失效，不按长度猜。
    let slots = this.planMemos.get(key);
    if (!slots) { slots = new Map(); this.planMemos.set(key, slots); }
    if (slots.size > 4) slots.clear();
    const memo = slots.get(entries);
    // 增量：新数组若是旧数组的超集（parseAppends 的形态），只扫新增尾部——
    // 否则静止会话每拍全扫 17609 条 entries（流式期间每 delta 一次），正是
    // 主进程 V8 反复重编译（deopt 风暴）的燃料。全量重算只在换分支/缓存
    // 重建（非前缀关系）时发生。
    let plan = memo?.plan;
    let scanFrom = 0;
    let planDoneWithNewTurn = false;
    if (memo && entries.length > memo.entries.length && entries.length - memo.entries.length <= memo.entries.length + 64) {
      // 前缀对齐校验：旧 entries 全部仍是新数组的前缀才敢增量
      let prefixOk = true;
      for (let i = 0; i < memo.entries.length; i += 1) {
        if (entries[i] !== memo.entries[i]) { prefixOk = false; break; }
      }
      if (prefixOk) { plan = memo.plan; scanFrom = memo.entries.length; planDoneWithNewTurn = memo.doneWithNewTurn ?? false; }
    }
    if (scanFrom === 0) plan = undefined;
    // 轮次边界：最后一次 user 消息之后才是「当前轮」。全 completed 且其后有新
    // user 消息 = 上一轮的已完成计划 → undefined（不残留）；未完成 → 保留。
    let lastUserAt = -1;
    for (let j = entries.length - 1; j >= 0; j -= 1) {
      const rm = (entries[j] as any)?.message;
      if (rm?.role === 'user') { lastUserAt = j; break; }
    }
    for (let index = scanFrom; index < entries.length; index += 1) {
      const entry = entries[index];
      // pi 的 toolResult 是独立 entry：message.role='toolResult'，toolName 在
      // message 层（此前误扫 message.content 里的 block——那里既没有 type=
      // 'toolResult' 的块也没有 toolName 字段，真实会话 125 次调用一次都扫不到，
      // 「跨窗口持久」等于没上线）。
      const m = entry.message as { role?: string; toolName?: string; content?: unknown } | undefined;
      if (!m || m.role !== 'toolResult' || m.toolName !== 'desktop_update_plan') continue;
      try {
        const blocks = Array.isArray(m.content) ? m.content : [];
        const text = blocks.map((b: any) => b?.text ?? '').join('');
        const value = JSON.parse(text)?.plan;
        if (Array.isArray(value) && value.length <= 30 && value.every((p: any) => p && typeof p.step === 'string' && ['pending', 'in_progress', 'completed'].includes(p.status))) {
          plan = value;
          planDoneWithNewTurn = index < lastUserAt && value.every((p: any) => p.status === 'completed');
        }
      } catch { /* 半截流式结果不替换上一份有效清单 */ }
    }
    slots.set(entries, { entries, plan, doneWithNewTurn: planDoneWithNewTurn });
    return planDoneWithNewTurn ? undefined : plan;
  }

  /** memo 化的 branchEntries：同 key 同 leaf 且 entries 未被增量解析替换时直接复用。
   *  注意 entries 是「同一引用」才命中——parseFile 增量会整体换数组，天然失效。 */
  private cachedBranch(key: string, entries: PiEntry[], leaf: string | undefined): PiEntry[] {
    // 每 leaf 一槽：两个 leaf 交替读（tail 首屏用最新 leaf、补拉/搜索定位用历史 leaf）
    // 不会互相顶掉。leaf 数有界（会话分叉数），entries 引用变化天然失效。
    const leafKey = leaf ?? '';
    let slots = this.branchMemo.get(key);
    if (!slots) { slots = new Map(); this.branchMemo.set(key, slots); }
    const memo = slots.get(leafKey);
    if (memo && memo.entries === entries) return memo.branch;
    // 前缀快路径：cache.branch 是「当前尾」的分支；同一链上更早的 leaf 的分支就是它的
    // 前缀（findIndex O(n) 字符串比较 ~几 ms，vs branchEntries 全量回溯 550ms）。分叉
    // leaf 不在当前分支上，才走全量回溯（低频：切换分支/跨分叉定位）。
    const base = this.cache.get(key)?.history.branch;
    if (base && base.length) {
      const idx = base.findIndex(e => e.id === leaf);
      if (idx === base.length - 1) { slots.set(leafKey, { entries, branch: base }); return base; }
      if (idx >= 0) {
        const branch = base.slice(0, idx + 1);
        slots.set(leafKey, { entries, branch });
        return branch;
      }
    }
    const branch = branchEntries(entries, leaf);
    slots.set(leafKey, { entries, branch });
    return branch;
  }

  private fromCache(key: string, leaf?: string, opts?: { tail?: number; before?: string; count?: number }): PiHistory {
    const cached = this.cache.get(key)?.history;
    if (!cached) throw new Error('会话不存在、不可读或不在选定目录中。');
    // 超限会话只做了元数据降级：列表可见但全量历史不可读，给可执行错误而不是空历史。
    if (this.oversized.has(cached)) throw new OversizedSessionError(cached.session.path, cached.session.size);
    if (leaf && !cached.entries.some(e => e.id === leaf)) throw new Error('Unknown leaf');
    // leaf 为空或就是当前尾（流式期间 history(key, leafId) 的绝对多数形态）：
    // cache.branch 本身就是这条分支（parseAppends 已增量维护），直接引用，零回溯。
    const full = !leaf || leaf === cached.leafId
      ? cached // leaf 为空或就是当前尾：cache.branch 即目标分支（parseAppends 已增量维护）
      : { ...cached, branch: this.cachedBranch(key, cached.entries, leaf), leafId: leaf };
    const tail = opts?.tail;
    const before = opts?.before;
    // tail/before 只裁 branch（渲染层消费的那一份）。entries/leaves 保持全量：分页
    // 游标与叶子切换要用完整结构；且它们不含消息正文（content 在 branch 的 entry 里），
    // 体积远小于 branch。裁掉的条数通过 truncated 告知调用方。
    // before：向上补拉一页——返回 [before 之前 count 条] + [before 起的全部尾部]，
    // 调用方把新页拼到自己已有 branch 的前面即得到更长的历史。
    if (before) {
      const at = full.branch.findIndex(e => e.id === before);
      if (at > 0) {
        const count = Math.max(1, Math.min(opts?.count ?? 500, at));
        const page = full.branch.slice(Math.max(0, at - count), at);
        return this.wireLite(key, { ...full, branch: [...page, ...full.branch.slice(at)], truncated: { total: full.branch.length, returned: page.length + (full.branch.length - at) } });
      }
      return full;
    }
    if (typeof tail === 'number' && tail > 0 && full.branch.length > tail) {
      const branch = full.branch.slice(full.branch.length - tail);
      return this.wireLite(key, { ...full, branch, truncated: { total: full.branch.length, returned: tail } });
    }
    // plan 与分页无关：任何 IPC history() 调用都要带（renderer planFallback 消费
    // 它；无 tail 时此前整条链路不带 plan——面板跨窗口兜底从未生效）。
    return this.wireLite(key, full);
  }
  start(changed: () => void): Promise<void> {
    this.close();
    const signature = (sessions: PiSession[]) => sessions.map(s => `${s.key}:${s.size}:${s.updatedAt}:${s.warnings?.length ?? 0}`).join('|');
    let last = signature(this.scan(true));
    const check = () => {
      try {
        // watch 事件定向处理（不 walk）：流式期间 pi 每 delta 追加一次会话文件，
        // watch 每 120ms 触发——若这里每次全量 walk（312 目录 scandir，实测 244ms/次）
        // 就是主进程满核（用户 2026-10-18 实测 100.6% CPU 的根因）。定向 stat 已知
        // 文件 + 处理 watch 报告的路径，常态 ~15ms。
        const targets = [...this.pendingPaths]; this.pendingPaths.clear();
        let rescan = false;
        if (targets.length) rescan = this.refreshTargets(targets);
        const dirsScan = this.pendingDirsScan; this.pendingDirsScan = false;
        // 已知文件的 stat 增量：watch 漏事件兜底（watch 报告的文件走 refreshTargets
        // 定向路径，不依赖这里）。全表 stat（数百文件）磁盘忙时单次数百 ms，限频 2s。
        let sawChange = false;
        const statSweepNow = Date.now();
        // 30s 低频兜底：watch 健康（FSEvents 正常报告文件事件）时全表 stat 只是
        // 漏事件保险——此前 2s 一轮，磁盘忙时一轮几百 ms（772 个 statSync）就是
        // 周期 100% 尖峰（实测 uv_fs_* 风暴）。定向路径（watch 报告的文件）不受影响。
        if (statSweepNow - this.lastStatSweep >= 30_000) {
          this.lastStatSweep = statSweepNow;
          // 包含拒绝文件及暂时读取失败的文件：stamp 变化要重试，未变则不读内容。
          for (const file of [...this.fileDirs.keys()]) {
            const key = fileKey(file);
            const stamped = this.stampOf(file);
            if (!stamped) { this.refreshOne(file, this.fileDirs.get(file) ?? ''); sawChange = true; continue; }
            if ((this.cache.get(key)?.stamp ?? this.rejected.get(file)) === stamped.stamp) continue;
            this.refreshOne(file, this.fileDirs.get(file) ?? '');
            sawChange = true;
          }
        }
        // 已知目录顶层 readdir：发现新会话文件（watch 失效时的轮询兜底，~20ms）
        for (const dir of this.knownDirs) {
          let items: fs.Dirent[];
          try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
          for (const item of items) {
            if (!item.isFile() || !item.name.endsWith('.jsonl')) continue;
            const full = path.join(dir, item.name);
            let real: string;
            try { real = fs.realpathSync(full); } catch { continue; }
            if (this.fileDirs.has(real)) continue;
            this.fileDirs.set(real, this.roots.find(r => real.startsWith(canonical(r))) ?? '');
            this.refreshOne(real, this.fileDirs.get(real)!);
            sawChange = true;
          }
        }
        // 已知目录的浅层发现（含新子目录一层）：纯轮询拍或 root 级事件拍才做。
        // 文件级 watch 事件拍跳过（流式期间 watch 每 120ms 触发，这步每拍 ~50ms
        // 也会吃掉半核）。
        // 最小间隔 2s：FSEvents 高频发空 filename 事件时（目录操作密集期），浅层
        // 发现每拍 ~50ms 仍会吃掉半核——限频后最坏 ~2.5%。
        const nowMs = Date.now();
        // 30s 低频兜底（同上）：watch 空文件名事件（pendingDirsScan）仍即时触发浅层发现。
        const shallowDue = nowMs - this.lastShallowScan >= 30_000;
        if ((targets.length === 0 || dirsScan) && shallowDue) {
          this.lastShallowScan = nowMs;
          const queue = [...this.knownDirs];
          for (let i = 0; i < queue.length; i += 1) {
            const dir = queue[i]!;
            let items: fs.Dirent[];
            try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
            for (const item of items) {
              const full = path.join(dir, item.name);
              if (item.isDirectory()) {
                let real: string;
                try { real = fs.realpathSync(full); } catch { continue; }
                if (!this.knownDirs.has(real)) { this.knownDirs.add(real); queue.push(real); }
                continue;
              }
              if (!item.isFile() || !item.name.endsWith('.jsonl')) continue;
              let real: string;
              try { real = fs.realpathSync(full); } catch { continue; }
              if (this.fileDirs.has(real)) continue;
              this.fileDirs.set(real, this.roots.find(r => real.startsWith(canonical(r))) ?? '');
              this.refreshOne(real, this.fileDirs.get(real)!);
              sawChange = true;
            }
          }
        }
        // 增量态 signature 直接从 cache 构建：refreshOne 已同步更新 session 元数据，
        // 流式追加/新文件都不需要全量 walk（此前每次变化都付 244ms 全量 scan）。
        let next: string;
        if (rescan) {
          next = signature(this.scan(true)); // 目录级变化：统一 nested 推断
        } else {
          this.checkCount += 1;
          if (this.checkCount >= 30) { this.checkCount = 0; this.scan(true); }
          next = signature([...this.cache.values()].map(x => x.history.session));
        }
        if (next !== last) { last = next; changed(); }
      } catch { /* retry on next poll */ }
      if (this.dirty.size) this.scheduleSettle(changed);
    };
    for (const root of this.roots) {
      // roots 始终在发现队列：目录可能尚不存在（测试/首次启动），watch 建不起来时
      // 纯轮询靠浅层发现循环兜底——readdir 失败自然跳过，目录出现后首轮 check 即发现。
      try { this.knownDirs.add(canonical(root)); } catch { this.knownDirs.add(root); }
      try {
      this.watchers.push(fs.watch(root, { recursive: true }, (_event, filename) => {
        // macOS FSEvents 对目录级事件（子目录创建/删除/重命名）经常不给 filename。
        // 此前把整个 root 塞进 pendingPaths → statSync(root)=目录 → rescan=true →
        // 每次 watch 事件都全量 scan（244ms）→ 流式期间主进程实测 99.8%。
        // 现在只置一个轻量标志：本轮做 knownDirs 浅层发现（~几十 ms），不触发全量。
        if (filename) this.pendingPaths.add(path.resolve(root, filename));
        else this.pendingDirsScan = true;
        clearTimeout(this.debounce); this.debounce = setTimeout(check, 120);
      }));
      } catch { /* Poll fallback includes new roots. */ }
    }
    this.timer = setInterval(check, 1200); this.timer.unref();
    return Promise.resolve();
  }

  /** watch 报告的路径定向处理：文件走 refreshOne；目录只 walk 该目录；删除清缓存。
   *  返回是否需要全量 rescan（目录级变化/无法定位归属时）。 */
  private refreshTargets(targets: string[]): boolean {
    let rescan = false;
    for (const target of targets) {
      let st: fs.Stats | undefined;
      try { st = fs.statSync(target); } catch { st = undefined; }
      if (st?.isDirectory()) {
        // 目录级事件：只浅层 readdir 该目录一层发现新会话文件（此前 rescan=true
        // 每次全量 walk 244ms——流式期间子会话目录操作频繁，主进程被打满）。
        try {
          const root = this.roots.find(r => target.startsWith(canonical(r))) ?? '';
          for (const item of fs.readdirSync(target, { withFileTypes: true })) {
            if (!item.isFile() || !item.name.endsWith('.jsonl')) continue;
            const full = path.join(target, item.name);
            let real: string;
            try { real = fs.realpathSync(full); } catch { continue; }
            if (this.fileDirs.has(real)) continue;
            this.fileDirs.set(real, root);
            this.refreshOne(real, root);
          }
        } catch { /* 目录又被删：下轮兜底 */ }
        continue;
      }
      if (st?.isFile() && target.endsWith('.jsonl')) {
        try {
          const real = fs.realpathSync(target);
          const root = this.fileDirs.get(real) ?? this.roots.find(r => real.startsWith(canonical(r))) ?? '';
          this.fileDirs.set(real, root);
          this.refreshOne(real, root);
        } catch { /* 并发删除：下轮 stat 兜底清理 */ }
        continue;
      }
      if (!st) {
        // 路径消失：可能是文件或目录。按文件清；目录级清理交给全量兜底。
        this.forgetFile(target);
      }
    }
    return rescan;
  }

  /** 单文件处理（scan 循环体与 watch 定向路径共用）：按 stamp 决定跳过/更新元数据/
   *  解析/降级/清理。file 不存在时走清理分支。 */
  private refreshOne(file: string, root: string): void {
    const key = fileKey(file);
    try {
      const stamped = this.stampOf(file);
      if (!stamped) { this.forgetFile(file); return; }
      const { stat, stamp } = stamped;
      this.fileDirs.set(file, root || this.fileDirs.get(file) || '');
      const cached = this.cache.get(key);
      if ((cached?.stamp ?? this.rejected.get(file)) === stamp) return;
      if (cached && stat.size > DEFER_PARSE_BYTES) {
        cached.history.session.size = stat.size;
        cached.history.session.updatedAt = stat.mtimeMs;
        this.dirty.set(key, file);
        return;
      }
      this.parseFile(file, key);
      if (root) this.fileDirs.set(file, root);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') { this.forgetFile(file); return; }
      if (err instanceof OversizedSessionError) {
        try {
          const stub = sessionStub(file);
          const stamped = this.stampOf(file);
          if (!stub || !stamped) return;
          const { stat, stamp } = stamped;
          const degraded = {
            session: { key, id: String(stub.header.id ?? key), path: file, cwd: String(stub.header.cwd ?? path.dirname(file)), name: String(stub.firstUserText || '未命名 pi 会话').slice(0, 180), updatedAt: stat.mtimeMs, size: stat.size, warnings: [err.message], owned: file.startsWith(canonical(this.ownedRoot) + path.sep), parentSession: typeof stub.header.parentSession === 'string' ? stub.header.parentSession : this.nestedParents.get(file), sidecarOf: path.basename(file).startsWith('sidecar_') ? '' : undefined, oversized: true } as PiSession,
            entries: [], branch: [], leaves: [], leafId: null as string | null, syncedAt: Date.now(),
          };
          this.oversized.add(degraded);
          this.cache.set(key, { stamp, history: degraded, parsedBytes: 0, pendingTail: Buffer.alloc(0), parsedIno: stat.ino });
        } catch { /* 并发删除：下轮兜底 */ }
        return;
      }
      const old = this.cache.get(key);
      if (old) old.history.session.warnings = [(err as Error).message];
    }
  }
  close() { clearInterval(this.timer); clearTimeout(this.debounce); clearTimeout(this.settleTimer); this.watchers.forEach(w => w.close()); this.watchers = []; this.dirty.clear(); }
}
