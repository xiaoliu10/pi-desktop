import fs from 'node:fs';
import path from 'node:path';
import type { SessionIndex } from './session-index';
import { childSessionPointer, readSnapshotJson, STALE_MS, subagentAsyncRoot, workflowSnapshots, type SubagentSnapshot } from './subagent-snapshots';
import { singleAsyncDetails, workflowDetails, workflowId, workflowState } from '../../shared/subagent-workflow';
import { OMITTED_THINKING_TEXT } from '../../shared/subagent-transcript';

/** recoverSubagents 的输入签名：会话身份 + 分支尖端 + pinned + async/persisted 目录
 *  的 (名字, mtime) 清单 + 30s 量化的时钟。输入不变 → 输出不变（STALE/幽灵降级等
 *  时间性判定按 30s 粒度进签名，最多晚一档变化）。已知 knownSignature 只省了 IPC
 *  序列化——主进程每 30s 仍全量重算 workflowSnapshots（大会话 900ms+，event-loop
 *  阻塞与打字卡顿的直接来源）；这里把「计算本身」也短路掉。
 *  成本：2 次 readdir + ≤(256+64) 次 stat（元数据 IO，实测 ~10ms 级）。 */
export async function recoverInputSignature(agentDir: string, sessionKey: string, leaf: string | undefined, pinned: string[] | undefined, root: string): Promise<string> {
  const parts = [sessionKey, leaf ?? '', (pinned ?? []).join(','), Math.floor(Date.now() / 30_000)];
  try {
    const dirents = await fs.promises.readdir(root, { withFileTypes: true });
    const names = dirents.filter(d => d.isDirectory()).map(d => d.name).sort();
    parts.push('async:' + names.length);
    for (const n of names.slice(0, 256)) {
      // stat 的是 status.json 而非 run 目录：目录 mtime 只在增删时变，run 进展
      // （running→completed）更新的是 status.json 的 mtime——目录级签名会吞掉
      // 运行中状态更新（行为测试抓到的真缺陷）。
      try { parts.push(n + ':' + (await fs.promises.stat(path.join(root, n, 'status.json'))).mtimeMs); } catch { parts.push(n + ':gone'); }
    }
  } catch { parts.push('async:none'); }
  try {
    const pdir = path.join(agentDir, 'subagents');
    const dirents = await fs.promises.readdir(pdir, { withFileTypes: true });
    const mine = dirents.filter(d => d.isFile() && d.name.startsWith(sessionKey + '_')).map(d => d.name).sort();
    parts.push('persisted:' + mine.length);
    for (const n of mine.slice(0, 64)) {
      try { parts.push(n + ':' + (await fs.promises.stat(path.join(pdir, n))).mtimeMs); } catch { /* gone */ }
    }
  } catch { /* 无持久化目录 = 空清单 */ }
  return parts.join('|');
}

const lastRecoverSigs = new Map<string, string>(); // key → 输入签名（多视图轮询互不踢；cap 防泄漏）



/** 只读能力状态（替代已删的 officialSubagentStatus/enableOfficialSubagent）：
 *  不写盘、不注册任何东西——内置 subagent 已删，只报告第三方供给情况。 */
export function subagentCapabilityStatus(agentDir: string): { available: boolean; source?: string } {
  const detected = detectThirdPartySubagent(agentDir);
  return { available: detected.detected, source: detected.source };
}

/**
 * Detect whether a third-party subagent extension/package is installed.
 * 2026-10-18 起内置 desktop-subagent 已全删，子代理能力由用户自选扩展提供；
 * 此函数仅用于设置页状态展示（告诉用户当前哪个包在提供子代理能力）。
 * Checks: settings.json packages for npm:*subagent*, and agentDir/extensions/
 * for any directory with "subagent" in the name (except desktop's own).
 */
export function detectThirdPartySubagent(agentDir: string): { detected: boolean; source?: string } {
  // Check settings.json packages
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8'));
    const pkgs = (settings.packages ?? []) as any[];
    for (const p of pkgs) {
      const s = typeof p === 'string' ? p : p?.source ?? '';
      if (/subagents?/i.test(s) && !/desktop/i.test(s)) return { detected: true, source: s };
    }
  } catch { /* settings may not exist yet */ }
  // Check agentDir/extensions/ for user-installed subagent extensions
  const extDir = path.join(agentDir, 'extensions');
  if (fs.existsSync(extDir)) {
    for (const name of fs.readdirSync(extDir)) {
      if (/subagents?/i.test(name) && name !== 'desktop-official-subagent' && name !== 'desktop-subagent') {
        return { detected: true, source: name };
      }
    }
  }
  return { detected: false };
}

/**
 * Migrate: remove the old desktop-official-subagent from agentDir/extensions/.
 * Desktop now loads its fallback subagent via -e flag, not from the discovery path.
 * This eliminates the conflict with npm:pi-subagents.
 */
export function migrateOldSubagentExtension(agentDir: string): boolean {
  const oldDir = path.join(agentDir, 'extensions', 'desktop-official-subagent');
  if (!fs.existsSync(oldDir)) return false;
  try { fs.rmSync(oldDir, { recursive: true, force: true }); return true; } catch { return false; }
}

/** Status for the UI: is desktop's fallback active, or is a third-party plugin in use? */

/**
 * Enable desktop's subagent support: create the scout agent definition.
 * The fallback extension itself is loaded via -e in backend.launch(), not from disk.
 * This is idempotent and safe to call repeatedly.
 */

/** Recover only the selected, trusted session/branch. No renderer-supplied paths. */
export async function recoverSubagents(agentDir: string, sessionKey: string, index: Pick<SessionIndex, 'subagentHistory'>, leaf?: string, pinned?: string[], knownSignature?: string): Promise<SubagentSnapshot[] | { unchanged: true }> {
  if (!/^[a-f0-9]{64}$/.test(sessionKey) || (leaf !== undefined && typeof leaf !== 'string')) return [];
  // 输入签名短路：单会话视角（同一时刻只有一个选中会话在轮询）。输入没变时连
  // workflowSnapshots 都不跑——已知输出必然与上次相同，直接回 unchanged（几十字节）。
  if (knownSignature !== undefined) {
    const sig = await recoverInputSignature(agentDir, sessionKey, leaf, pinned, subagentAsyncRoot());
    if (sig === lastRecoverSigs.get(sessionKey)) return { unchanged: true };
    if (lastRecoverSigs.size > 4) lastRecoverSigs.clear();
    lastRecoverSigs.set(sessionKey, sig);
  }
  let history;
  try { history = index.subagentHistory(sessionKey, leaf); } catch { return []; }
  const persisted = await readPersistedSnapshots(agentDir, sessionKey);
  // pinned：渲染层正在展示的 callId（尤其尾窗 32 条之外的老工作流卡片）。它们必须
  // 读盘校正终态——tool result 里的 workflowChildren.workflowState 是落盘快照，
  // 工作流结束后不回写，不校正就会永远显示「运行中/等待工作流报告子任务」。
  const workflows = await workflowSnapshots(history, persisted, subagentAsyncRoot(), Date.now(), pinned);
  // single-async records are already normalized into `workflows`; leaving them in
  // legacy would duplicate the callId and let the raw record shadow the snapshot.
  const legacy = persisted.filter(rec => !workflowDetails(rec.details, rec.callId) && !singleAsyncDetails(rec.details, rec.callId));
  const records = [...legacy, ...workflows];
  // 与 renderer 同款轻量签名：未变化时只回 {unchanged:true}，避免每 10s 把
  // 数百子代理快照（含转录）过一遍 IPC 结构化克隆（周期 100% 尖峰实测来源，
  // ValueSerializer 热点）。签名与 renderer/subagent-polling 的字段保持一致。
  if (knownSignature !== undefined) {
    const sig = records.map(r => {
      const d = r.details as { snapshotAt?: number; runId?: string } | undefined;
      return `${r.callId}|${r.status}|${r.error ?? ''}|${r.startedAt ?? ''}|${d?.snapshotAt ?? ''}|${d?.runId ?? ''}`;
    }).join('\n');
    if (sig === knownSignature) return { unchanged: true };
  }
  return records;
}

/** Event-level persisted snapshots for one session (hash-owned file names only). */
async function readPersistedSnapshots(agentDir: string, sessionKey: string): Promise<SubagentSnapshot[]> {
  const persisted: SubagentSnapshot[] = [];
  if (!/^[a-f0-9]{64}$/.test(sessionKey)) return persisted;
  const dir = path.join(agentDir, 'subagents');
  // Bounded directory iteration (never recursive); legacy event snapshots only.
  try {
    const entries = await fs.promises.opendir(dir);
    let count = 0;
    try { for await (const entry of entries) {
      if (++count > 2048 || persisted.length >= 32) break;
      const prefix = sessionKey + '_';
      if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith('.json')) continue;
      const callId = entry.name.slice(prefix.length, -5);
      if (!workflowId(callId)) continue;
      try {
        const data = await readSnapshotJson(dir, path.join(dir, entry.name), { bytes: 256 * 1024 });
        if (data.callId === callId) persisted.push(data);
      } catch { /* missing/oversized/unsafe/corrupt is not success */ }
    } } finally { await entries.close().catch(() => undefined); }
  } catch { /* event persistence is optional; history remains authoritative */ }
  return persisted;
}

const TRANSCRIPT_TAIL_BYTES = 1536 * 1024;
const TRANSCRIPT_MESSAGES = 60;
const TRANSCRIPT_TEXT_CAP = 6000;
/** 单条 thinking 按需拉取的上限（字符）：点开才跨 IPC，但仍要有界（实测单块最大 37KB+，
 *  给足余量到 100K；超出截断并标记 truncated）。 */
const THINKING_DETAIL_CAP = 100_000;
const boundedStr = (value: unknown, max: number): string => typeof value === 'string' ? value.slice(0, max) : '';

/** Display-only sanitization. Strictly typed: non-string text/content never crosses
 *  IPC; thinking payloads and image data are replaced with placeholders; tool
 *  identity (toolCallId/toolName/isError) is preserved in bounded form so failed
 *  tool results still render as failures of their own call. */
function sanitizeTranscriptMessage(message: any): Record<string, unknown> {
  const capText = (t: unknown): string => typeof t === 'string' ? (t.length > TRANSCRIPT_TEXT_CAP ? `${t.slice(0, TRANSCRIPT_TEXT_CAP)}…` : t) : '';
  const sanitizeBlocks = (blocks: unknown): Record<string, unknown>[] => {
    if (typeof blocks === 'string') return [{ type: 'text', text: capText(blocks) }];
    if (!Array.isArray(blocks)) return [];
    return blocks.map((block: any) => {
      if (!block || typeof block !== 'object') return { type: 'text', text: '' };
      if (block.type === 'text') return { type: 'text', text: capText(block.text) };
      if (block.type === 'thinking') return { type: 'thinking', thinking: OMITTED_THINKING_TEXT };
      if (block.type === 'image') return { type: 'text', text: '[image]' };
      if (block.type === 'toolCall') {
        let args = block.arguments;
        try { const serialized = JSON.stringify(args); if (typeof serialized === 'string' && serialized.length > 2000) args = { preview: `${serialized.slice(0, 2000)}…`, truncated: true }; } catch { args = { truncated: true }; }
        return { type: 'toolCall', id: boundedStr(block.id, 200), name: boundedStr(block.name, 200), arguments: args };
      }
      if (block.type === 'toolResult') return { type: 'toolResult', toolCallId: boundedStr(block.toolCallId, 200), content: Array.isArray(block.content) ? block.content.map((c: any) => c && c.type === 'text' ? { type: 'text', text: capText(c.text) } : { type: 'text', text: `[${boundedStr(c?.type, 40) || 'block'}]` }) : [] };
      return { type: 'text', text: `[${boundedStr(block.type, 40) || 'block'}]` };
    });
  };
  const role = typeof message?.role === 'string' ? message.role : 'assistant';
  const base: Record<string, unknown> = { role, content: sanitizeBlocks(message?.content) };
  // pi puts tool results on their own message with call identity at the top level;
  // dropping those fields would render failures as anonymous successful tools.
  if (role === 'toolResult') {
    base.toolCallId = boundedStr(message?.toolCallId, 200);
    base.toolName = boundedStr(message?.toolName, 200);
    base.isError = message?.isError === true;
  }
  return base;
}

/** Read-only child transcript for the detail panel. The session file is resolved
 *  through childSessionPointer (validated pointer chain) and must live inside the
 *  parent session's directory (nested child layout); anything else is rejected.
 *  Read discipline mirrors readSnapshotJson: symlink-free ancestor walk, O_NOFOLLOW
 *  open, fd-fstat identity match, post-open re-verification. Only a bounded,
 *  sanitized tail crosses IPC; every failure becomes a fixed error code (never a
 *  Node error carrying absolute paths). */
/** 受控读取子会话尾部（指针链解析 + 符号链接/身份校验 + 有界尾窗）。
 *  subagentChildTranscript 与 subagentChildThinking 共用同一读纪律：任何失败都变成
 *  固定错误码（不带绝对路径），只有有界文本跨 IPC。 */
async function readChildSessionTail(agentDir: string, sessionKey: string, index: Pick<SessionIndex, 'subagentHistory'>, callId: string, childId: string): Promise<{ text: string; windowTruncated: boolean } | { error: string }> {
  if (!/^[a-f0-9]{64}$/.test(sessionKey) || !workflowId(callId) || !workflowId(childId)) return { error: 'bad-args' };
  let history;
  try { history = index.subagentHistory(sessionKey); } catch { return { error: 'no-history' }; }
  const persisted = await readPersistedSnapshots(agentDir, sessionKey);
  const file = await childSessionPointer(history, persisted, callId, childId);
  if (!file) return { error: 'no-snapshot' };
  let real: string, trustedParent: string;
  try {
    real = fs.realpathSync(file);
    // Compare realpaths on both sides: parent dir may sit behind a symlink
    // (e.g. macOS /var → /private/var).
    trustedParent = fs.realpathSync(path.dirname(history.session.path));
  } catch { return { error: 'no-snapshot' }; }
  if (!real.startsWith(trustedParent + path.sep)) return { error: 'outside-sessions-root' };
  // Reject symlinked ancestors between the trusted parent dir and the file.
  const walkCheck = () => {
    let current = trustedParent;
    for (const segment of real.slice(trustedParent.length + path.sep.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error('symlinked ancestor');
    }
  };
  let handle: fs.promises.FileHandle | undefined;
  try {
    walkCheck();
    const pre = fs.statSync(real);
    if (!pre.isFile() || pre.size > 64 * 1024 * 1024) return { error: 'no-snapshot' };
    handle = await fs.promises.open(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = await handle.stat(); // identity comes from the fd, not the path
    if (!stat.isFile() || stat.ino !== pre.ino || stat.dev !== pre.dev) return { error: 'no-snapshot' };
    walkCheck();
    if (fs.realpathSync(real) !== real) return { error: 'no-snapshot' };
    // Final identity binding: the CURRENT path must still resolve to the very inode
    // the fd holds. Closes the swap-ancestor → stat/open outside → restore window
    // where both `pre` and the fd already come from the outside file.
    const post = fs.statSync(real);
    if (!post.isFile() || post.ino !== stat.ino || post.dev !== stat.dev) return { error: 'no-snapshot' };
    // Windows: fs.constants.O_NOFOLLOW is undefined there (flags degrade to O_RDONLY).
    // The walkCheck above provides the symlink rejection via lstat (works for
    // symlinks and junctions); this matches the shipped readSnapshotJson posture.
    const tail = Math.min(stat.size, TRANSCRIPT_TAIL_BYTES);
    const buffer = Buffer.alloc(tail);
    const { bytesRead } = await handle.read(buffer, 0, tail, stat.size - tail);
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    if (tail < stat.size) text = text.slice(text.indexOf('\n') + 1); // drop partial line
    return { text, windowTruncated: tail < stat.size };
  } catch { return { error: 'read-failed' }; }
  finally { if (handle) await handle.close().catch(() => undefined); }
}

export async function subagentChildTranscript(agentDir: string, sessionKey: string, index: Pick<SessionIndex, 'subagentHistory'>, callId: string, childId: string): Promise<{ messages: Record<string, unknown>[]; truncated: boolean } | { error: string }> {
  const tail = await readChildSessionTail(agentDir, sessionKey, index, callId, childId);
  if ('error' in tail) return { error: tail.error };
  const messages: Record<string, unknown>[] = [];
  let total = 0;
  for (const line of tail.text.split('\n')) {
    if (!line) continue;
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.type === 'message' && entry.message && typeof entry.message.role === 'string') {
      total++;
      const sanitized = sanitizeTranscriptMessage(entry.message);
      // 稳定 entry id 随消息过 IPC：渲染层点开「省略思考」块时按 id+块下标按需拉取
      // 真实内容（append-only jsonl，历史条目 id 不漂移）。
      const entryId = boundedStr(entry.id, 80);
      messages.push(entryId ? { ...sanitized, id: entryId } : sanitized);
    }
  }
  const out = messages.slice(-TRANSCRIPT_MESSAGES);
  return { messages: out, truncated: total > out.length || tail.windowTruncated };
}

/** 单条 thinking 的按需拉取（详情面板点开省略块时触发；默认转录载荷与现状一致）。
 *  寻址用稳定 entry id + 内容块下标；复用 readChildSessionTail 的全部读纪律；
 *  超过 THINKING_DETAIL_CAP 截断并标记 truncated；非 thinking 块/未知条目一律 not-found。 */
export async function subagentChildThinking(agentDir: string, sessionKey: string, index: Pick<SessionIndex, 'subagentHistory'>, callId: string, childId: string, entryId: string, blockIndex: number): Promise<{ thinking: string; truncated: boolean } | { error: string }> {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(entryId) || !Number.isInteger(blockIndex) || blockIndex < 0 || blockIndex > 1000) return { error: 'bad-args' };
  const tail = await readChildSessionTail(agentDir, sessionKey, index, callId, childId);
  if ('error' in tail) return { error: tail.error };
  for (const line of tail.text.split('\n')) {
    if (!line) continue;
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.type !== 'message' || entry.id !== entryId) continue;
    const content = entry.message?.content;
    if (!Array.isArray(content)) return { error: 'not-found' };
    const block = content[blockIndex];
    if (!block || typeof block !== 'object' || block.type !== 'thinking' || typeof block.thinking !== 'string') return { error: 'not-found' };
    const thinking: string = block.thinking;
    return thinking.length > THINKING_DETAIL_CAP
      ? { thinking: thinking.slice(0, THINKING_DETAIL_CAP), truncated: true }
      : { thinking, truncated: false };
  }
  return { error: 'not-found' };
}

/** Clean up all persisted subagent files for a session (on disconnect/close). */
export function cleanupSubagents(agentDir: string, sessionKey: string) {
  if (!/^[a-f0-9]{64}$/.test(sessionKey)) return;
  const dir = path.join(agentDir, 'subagents');
  if (!fs.existsSync(dir)) return;
  const prefix = sessionKey + '_';
  for (const f of fs.readdirSync(dir).filter(f => f.startsWith(prefix) && f.endsWith('.json'))) {
    try { fs.unlinkSync(path.join(dir, f)); } catch {}
  }
}

/**
 * Event-level subagent progress persistence. Called from backend.onEvent for any
 * tool_execution_start / message_update / tool_execution_end where tool === 'subagent'.
 * Works for ALL subagent implementations (official, npm pi-subagents, custom) because
 * it observes RPC events, not the extension's internal onUpdate callback.
 */
/** 按会话聚合「运行中子代理数」：侧栏会话行的菊花要在主 run 结束后继续转，
 *  否则用户误以为任务已结束（子代理还在后台跑）。数据源是 persistSubagentEvent
 *  落的快照文件；只数 status=running 且未 stale 的（STALE_MS 与 subagent-snapshots
 *  同口径）——死快照不能让菊花永转。顺手把 stale 文件删掉：workflow 型快照的
 *  completed 清理被特意跳过（recoverSubagents 要读它做详情恢复），于是「跑到一半
 *  进程死了」的快照会永远留在 running 态——用户侧栏因此显示幽灵运行中
 *  （真实 bug：4 天前的快照让侧栏常驻 5 个「正在运行」）。 */
export function runningSubagentCounts(agentDir: string, now = Date.now(), opts: { sweep?: boolean; observedCalls?: ReadonlySet<string> } = {}): Record<string, number> {
  const dir = path.join(agentDir, 'subagents');
  const counts: Record<string, number> = {};
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return counts; }
  for (let i = 0; i < entries.length && i < 4096; i += 1) {
    const name = entries[i]!;
    if (!name.endsWith('.json')) continue;
    // 文件名 = <sessionKey>_<callId>.json；sessionKey 是 64 位十六进制（调用方已校验过）。
    const sep = name.indexOf('_');
    if (sep !== 64) continue;
    const sessionKey = name.slice(0, sep);
    if (!/^[a-f0-9]{64}$/.test(sessionKey)) continue;
    try {
      const snap = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      // Async status is newer than the frozen launch-tool result (including completion).
      if (opts.observedCalls?.has(sessionKey + ':' + snap?.callId)) continue;
      if (snap?.status !== 'running' && snap?.status !== 'queued') continue;
      const updatedAt = Number(snap.updatedAt) || 0;
      if (!updatedAt || now - updatedAt > STALE_MS) {
        // stale 的 running 快照：进程早死了，事件不会再更新它。**改写为终态而不是删除**——
        // pointers() 靠持久化快照补齐「有 toolCall 无 toolResult」的崩溃调用，删文件会让
        // 详情卡片与子代理 transcript 指针一起消失（code review 探针实测：删后 0 张卡）。
        // 改写成终态同样让计数归零，且保留崩溃现场供恢复。
        if (opts.sweep && !snap.__swept) {
          try {
            fs.writeFileSync(path.join(dir, name), JSON.stringify({ ...snap, status: 'interrupted', updatedAt: now, __swept: true }));
          } catch { /* best-effort：写失败保持原样，计数侧同样不认它 */ }
        }
        continue;
      }
      counts[sessionKey] = (counts[sessionKey] ?? 0) + 1;
    } catch { /* 快照损坏/半写：跳过，不影响其他会话 */ }
  }
  return counts;
}

export function persistSubagentEvent(agentDir: string, sessionKey: string, callId: string, event: Record<string, any>) {
  if (!/^[a-f0-9]{64}$/.test(sessionKey) || !workflowId(callId)) return;
  const dir = path.join(agentDir, 'subagents');
  const file = path.join(dir, `${sessionKey}_${callId}.json`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const details = event.partialResult?.details ?? event.result?.details;
    const workflow = workflowDetails(details, callId);
    const status = workflow ? workflowState(workflow.state ?? workflow.workflowChildren?.workflowState) : event.type === 'tool_execution_end' ? 'completed' : 'running';
    const payload: Record<string, unknown> = { callId, startedAt: Date.now(), status, updatedAt: Date.now() };
    if (details) payload.details = details;
    if (event.type === 'tool_execution_end' && event.result?.isError) payload.status = 'failed';
    fs.writeFileSync(file, JSON.stringify(payload), { mode: 0o600 });
    // Clean up on success after 5s (session file is source of truth)
    if (status === 'completed' && !workflow) {
      setTimeout(() => { try { fs.unlinkSync(file); } catch {} }, 5000).unref?.();
    }
  } catch { /* best-effort */ }
}
