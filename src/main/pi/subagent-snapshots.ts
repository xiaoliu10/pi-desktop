import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PiHistory } from '../../shared/pi';
import { isSubagentManagement, completionsDetails, singleAsyncDetails, singleRunRow, workflowDetails, workflowId, workflowObject as obj, workflowRows, workflowState, workflowText as text } from '../../shared/subagent-workflow';

export interface SubagentSnapshot { callId: string; status: string; details?: unknown; error?: string; startedAt?: number; updatedAt?: number }
const MAX_JSON = 256 * 1024;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_CALLS = 32;
const MAX_CHILDREN = 64;
export const STALE_MS = 5 * 60 * 1000;

export function subagentAsyncRoot(): string {
  const sanitize = (s: string) => s.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
  const scope = typeof process.getuid === 'function' ? `uid-${process.getuid()}` : `user-${sanitize(process.env.USERNAME || process.env.USER || os.userInfo().username)}`;
  return process.env.PI_SUBAGENTS_TEMP_ROOT?.trim() ? path.resolve(process.env.PI_SUBAGENTS_TEMP_ROOT.trim(), 'async-subagent-runs') : path.join(os.tmpdir(), `pi-subagents-${scope}`, 'async-subagent-runs');
}

/** mtime 结果缓存：轮询空闲档（10s）每拍对数百子代理逐个 read+parse status.json，
 *  文件没变结果必然相同——实测这就是主进程周期 100% 尖峰的来源（238 项 ≈ 0.3-0.5s
 *  的 IO+JSON+对象风暴，外加每项 ENOENT 的 PromiseReject 处理）。stat mtime（~5ms
 *  全表）命中即复用上次解析结果。容量护栏：超限整体清空（快照集是有限集合，
 *  清空只损失一轮缓存）。 */
const snapMemo = new Map<string, { mtimeMs: number; data: any }>();

export async function readSnapshotJsonCached(root: string, file: string, budget = { bytes: MAX_BYTES }): Promise<any> {
  try {
    const st = await fs.promises.stat(path.resolve(file));
    const hit = snapMemo.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.data;
    const data = await readSnapshotJson(root, file, budget);
    if (snapMemo.size > 4000) snapMemo.clear();
    snapMemo.set(file, { mtimeMs: st.mtimeMs, data });
    return data;
  } catch (e) {
    // stat 失败（ENOENT 等直接抛给调用方的既有语义）不缓存——出现/消失由下次 stat 决定
    throw e;
  }
}

/** Only exact, contained regular files. Never follow a symlink (including a directory).
 * Canonicalize the trusted OS temp anchor, not an untrusted pointer. Bounded reads also
 * hold when a file grows after fstat. A per-request byte budget bounds fanout work. */
export async function readSnapshotJson(root: string, file: string, budget = { bytes: MAX_BYTES }): Promise<any> {
  const absoluteRoot = path.resolve(root), absolute = path.resolve(file);
  const rel = path.relative(absoluteRoot, absolute);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('outside snapshot root');
  const check = async () => {
    // The OS temp directory may itself have a platform alias (/var -> /private/var).
    const anchor = path.parse(absoluteRoot).root;
    let current = anchor;
    for (const segment of absolute.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      const st = await fs.promises.lstat(current);
      if (st.isSymbolicLink()) {
        // Permit ONLY the platform's trusted tmpdir ancestors, not plugin roots.
        const temp = path.resolve(os.tmpdir());
        if (!(temp === current || temp.startsWith(current + path.sep)) || absoluteRoot === current) throw new Error('symlink');
      }
    }
    return fs.promises.realpath(absolute);
  };
  const real = await check();
  const handle = await fs.promises.open(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_JSON || stat.size > budget.bytes) throw new Error('snapshot too large');
    budget.bytes -= stat.size;
    const buffer = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== stat.size || await check() !== real) throw new Error('snapshot changed');
    const after = await fs.promises.stat(real);
    if (after.ino !== stat.ino || after.dev !== stat.dev || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error('snapshot changed');
    const value = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
    if (!obj(value)) throw new Error('invalid snapshot');
    return value;
  } finally { await handle.close(); }
}

/** Collect subagent call pointers from the branch (+ persisted event snapshots).
 *  `pinned` = a callId the caller will definitely consume: it survives the MAX_CALLS
 *  window even when a session has more subagent calls than the window holds (real
 *  sessions hit 30+; the tail window silently dropped older workflow cards, so
 *  on-demand transcript fetches for them returned no-snapshot). Pinning keeps the
 *  bounded scan for list rendering while making per-card reads always resolvable.
 *  Pure scan: no window math, so a 200-strong pinned list can reuse one pass
 *  instead of re-scanning the whole branch per callId (real 32k-entry sessions
 *  measured 287ms of main-thread CPU per recover tick that way). */
function collectPointers(history: PiHistory, persisted: SubagentSnapshot[]): { all: SubagentSnapshot[]; byCallId: Map<string, SubagentSnapshot>; coverage: Set<string> } {
  const calls = new Map<string, { at: number; management: boolean }>();
  const found = new Map<string, SubagentSnapshot>();
  // coverage：本分支历史上出现过的全部 runId（不止尾窗 32 条）。orphan 投影用它
  // 排除「有指针但落在窗口外」的老 run——窗口外是渲染层的刻意有界，不能被 orphan
  // 再捞回来（MAX_CALLS 契约）。
  const coverage = new Set<string>();
  const noteRun = (details: unknown, callId: string) => {
    const d = obj(details);
    for (const r of [d?.runId, d?.asyncId]) if (typeof r === 'string' && workflowId(r)) coverage.add(r);
  };
  const collect = (details: unknown, callId: string, at?: number) => {
    if (workflowDetails(details, callId) || singleAsyncDetails(details, callId) || completionsDetails(details, callId)) found.set(callId, { callId, status: 'unknown', details, startedAt: at });
    noteRun(details, callId);
  };
  for (const e of history.branch) {
    const m = e.message;
    if (m?.role === 'assistant' && Array.isArray(m.content)) for (const b of m.content) {
      if (b.type === 'toolCall' && b.name === 'subagent' && workflowId(b.id)) calls.set(b.id, { at: Date.parse(String(e.timestamp || '')) || 0, management: isSubagentManagement(JSON.stringify(b.arguments)) });
    }
    if (m?.role !== 'toolResult' || m.toolName !== 'subagent' || typeof m.toolCallId !== 'string' || calls.get(m.toolCallId)?.management) continue;
    collect(m.details, m.toolCallId, calls.get(m.toolCallId)?.at);
  }
  for (const rec of persisted) {
    if (calls.get(rec.callId)?.management) continue;
    // Events can precede the history append, but remain scoped to this session's
    // hash-owned persistence file. They are not a license to use arbitrary dirs.
    if (!found.has(rec.callId) && (workflowDetails(rec.details, rec.callId) || singleAsyncDetails(rec.details, rec.callId) || completionsDetails(rec.details, rec.callId))) found.set(rec.callId, rec);
    // coverage 同样要覆盖 persisted-only 指针的 runId：readPersistedSnapshots 的
    // 32 cap 或排序变化时，persisted 指针可能落在窗口外被 orphan 重复投影。
    noteRun(rec.details, rec.callId);
  }
  return { all: [...found.values()], byCallId: found, coverage };
}

/** 尾窗（最近 MAX_CALLS 条）+ 单个 pinned 穿透。窗口数学与扫描分离：pinned 只需要
 *  它自己那一条（窗口内原样、窗口外把最老的换出），不需要为每个 callId 重算整窗。 */
function pointersWindow(all: SubagentSnapshot[], pinned?: string): SubagentSnapshot[] {
  const window = all.slice(-MAX_CALLS);
  if (pinned && workflowId(pinned) && !window.some(p => p.callId === pinned)) {
    const hit = all.find(p => p.callId === pinned);
    // Replace the oldest window entry rather than growing it: list rendering stays
    // bounded; the pinned card is what the user is looking at right now.
    if (hit) { window.shift(); window.push(hit); }
  }
  return window;
}

/** Collect subagent call pointers from the branch (+ persisted event snapshots).
 *  `pinned` = a callId the caller will definitely consume: it survives the MAX_CALLS
 *  window even when a session has more subagent calls than the window holds (real
 *  sessions hit 30+; the tail window silently dropped older workflow cards, so
 *  on-demand transcript fetches for them returned no-snapshot). Pinning keeps the
 *  bounded scan for list rendering while making per-card reads always resolvable. */
function pointers(history: PiHistory, persisted: SubagentSnapshot[], pinned?: string): { window: SubagentSnapshot[]; coverage: Set<string> } {
  const collected = collectPointers(history, persisted);
  return { window: pointersWindow(collected.all, pinned), coverage: collected.coverage };
}

/** Main-process-only adapter. No scans, no session/transcript/prompt reads and no
 * returned filesystem pointers. The caller supplies trusted selected-branch history. */
export async function workflowSnapshots(history: PiHistory, persisted: SubagentSnapshot[], root = subagentAsyncRoot(), now = Date.now(), pinned?: string[]): Promise<SubagentSnapshot[]> {
  const budget = { bytes: MAX_BYTES };
  const output: SubagentSnapshot[] = [];
  // 渲染层已 pinned 的 callId 全部穿透尾窗：列表渲染保持 32 条有界，但这些卡片用户正
  // 在看——不穿透的话它们永远拿不到 asyncDir/status.json 的终态校正（tool result 里
  // 冻结的 workflowChildren.workflowState 永远是 'running'），于是「已结束的工作流」
  // 在面板里显示为「等待工作流报告子任务 · 运行中」（用户 2026-10-18 实测，238 对调用
  // 的会话里 16 个假活）。与渲染侧 pointers 的 pinned 修复（PR #132）同思路。
  // pinned 逐个取「该 callId 的指针」——它只需要自己那一条（窗内原样，窗外那条由
  // byCallId 直取、不经窗口），所以扫描只做一次：原来每个 pinned 都重跑一次 pointers()
  // （整条 branch 的 toolCall/toolResult 扫描），32k 条的真实会话上 200 个 pinned = 287ms
  // 主线程 CPU，recover 每 2-10s 一跳，正是大会话低 CPU 卡顿/尖峰的实证根因。修复后
  // 实测 4ms（287ms → 4ms，一次扫描 + O(1) 查找）。尾窗数学只管无 pin 的列表视图有界。
  // collected 同时供下面的尾窗循环与 orphan coverage 复用（同一份扫描结果）。
  let collected: { all: SubagentSnapshot[]; byCallId: Map<string, SubagentSnapshot>; coverage: Set<string> } | undefined;
  const allPointers = () => (collected ??= collectPointers(history, persisted));
  for (const callId of pinned ?? []) {
    if (!workflowId(callId) || output.some(o => o.callId === callId)) continue;
    const pointer = allPointers().byCallId.get(callId);
    if (pointer) output.push(await resolveWorkflowPointer(pointer, history, root, now, budget));
  }
/** Resolve one workflow pointer into a display snapshot (asyncDir/status.json 校正)。
 *  拆出来供 pinned 穿透路径复用：尾窗外的卡片同样要读盘校正终态。 */
async function resolveWorkflowPointer(pointer: SubagentSnapshot, history: PiHistory, root: string, now: number, budget: { bytes: number }): Promise<SubagentSnapshot> {
    const d = obj(pointer.details)!;
    const runId = d.runId;
    const isSingle = !!singleAsyncDetails(d, pointer.callId);
    let detail: Record<string, any> = { mode: 'workflow', runId, toolCallId: pointer.callId, state: 'unknown', steps: [] };
    let updatedAt = 0;
    try {
      const expectedDir = path.join(root, runId);
      if (typeof d.asyncDir !== 'string' || path.resolve(d.asyncDir) !== path.resolve(expectedDir) || (d.asyncId !== undefined && d.asyncId !== runId)) throw new Error('invalid async pointer');
      const status = await readSnapshotJsonCached(root, path.join(expectedDir, 'status.json'), budget);
      const validTime = (s: any) => Number.isFinite(s.startedAt) && Number.isFinite(s.lastUpdate) && s.lastUpdate >= s.startedAt && s.lastUpdate <= now + 60_000 && (!pointer.startedAt || s.startedAt >= pointer.startedAt - 60_000);
      if (isSingle) {
        // Async single run: one child whose state lives in status.json (mode:'single').
        // Revived runs may omit toolCallId; bind by runId + sessionId instead.
        if (status.mode !== 'single' || status.runId !== runId || status.sessionId !== history.session.path || (status.toolCallId !== undefined && status.toolCallId !== pointer.callId) || !validTime(status)) throw new Error('single snapshot identity/time mismatch');
        const row = singleRunRow(status);
        let state = workflowState(row.state);
        if (['running', 'queued'].includes(state) && now - (row.snapshotAt || 0) > STALE_MS) state = 'unknown';
        const child: Record<string, any> = { childId: row.childId, runId: workflowId(row.runId) ? row.runId : undefined, agent: text(row.agent), label: text(row.label), sessionName: text(row.sessionName), state, model: text(row.model) };
        if (typeof row.tokens === 'number') child.tokens = row.tokens;
        if (typeof row.turns === 'number') child.turns = row.turns;
        child.snapshotAt = row.snapshotAt;
        detail = { mode: 'workflow', runId, toolCallId: pointer.callId, state, snapshotAt: status.lastUpdate, workflowChildren: { version: 1, parentToolCallId: pointer.callId, workflowRunId: runId, inventoryComplete: true, workflowState: state, children: [child] } };
        updatedAt = Math.max(status.lastUpdate, child.snapshotAt || 0);
      } else {
        if (status.mode !== 'workflow' || status.runId !== runId || status.toolCallId !== pointer.callId || status.sessionId !== history.session.path || !validTime(status) || !workflowDetails(status, pointer.callId)) throw new Error('snapshot identity/time mismatch');
        const rows = workflowRows(status).slice(0, MAX_CHILDREN);
        const children: Record<string, any>[] = [];
        for (const row of rows) {
          // Only these display fields cross IPC. In particular do not recover
          // descriptions, prompts, sessionFile, transcriptPath or recent output.
          const child: Record<string, any> = { childId: row.childId, runId: workflowId(row.runId) ? row.runId : undefined, agent: text(row.agent), label: text(row.label), sessionName: text(row.sessionName), state: workflowState(row.state), model: text(row.model) };
          if (child.runId) {
            try {
              const s = await readSnapshotJsonCached(root, path.join(root, child.runId, 'status.json'), budget);
              if (s.runId !== child.runId || s.sessionId !== history.session.path || !workflowId(s.toolCallId) || s.parentWorkflowRunId !== runId || s.workflowKey !== row.childId || !validTime(s) || s.startedAt < status.startedAt) throw new Error('child identity/time mismatch');
              const state = workflowState(s.state);
              child.state = ['running', 'queued'].includes(state) && now - s.lastUpdate > STALE_MS ? 'unknown' : state;
              const step = Array.isArray(s.steps) ? obj(s.steps[0]) : undefined;
              child.model = text(step?.model) || child.model;
              child.tokens = typeof s.totalTokens?.total === 'number' && Number.isFinite(s.totalTokens.total) ? s.totalTokens.total : undefined;
              child.turns = typeof s.turnCount === 'number' && Number.isFinite(s.turnCount) ? s.turnCount : undefined;
              child.snapshotAt = s.lastUpdate;
            } catch { child.state = 'unknown'; }
          } else if (child.state !== 'queued') child.state = 'unknown';
          children.push(child);
        }
        // A workflow's timestamp may stop advancing while children run. Never
        // infer their completion from that timestamp or the parent's RPC state.
        let state = workflowState(status.state ?? status.workflowChildren?.workflowState);
        if (!children.length && ['running', 'queued'].includes(state) && now - status.lastUpdate > STALE_MS) state = 'unknown';
        detail = { ...detail, state, snapshotAt: status.lastUpdate, workflowChildren: { version: 1, parentToolCallId: pointer.callId, workflowRunId: runId, inventoryComplete: status.workflowChildren?.inventoryComplete === true, workflowState: state, children } };
        updatedAt = Math.max(status.lastUpdate, ...children.map(c => c.snapshotAt || 0));
      }
    } catch {
      // Keep known identities on unavailable/corrupt snapshots without presenting
      // last-known running/completed as a newly verified observation.
      if (isSingle) detail.steps = [{ childId: 'single', runId, agent: text(d.agent), state: 'unknown' }];
      else detail.steps = workflowRows(d).map(row => ({ childId: row.childId, runId: row.runId, agent: text(row.agent), state: 'unknown' }));
    }
  return { callId: pointer.callId, status: detail.state, details: detail, updatedAt };
}

  for (const pointer of pointersWindow(allPointers().all)) {
    output.push(await resolveWorkflowPointer(pointer, history, root, now, budget));
  }
  // Harness 派生的 async 子代理（codemode runs.run、detached children）在父会话
  // 历史里没有 subagent toolCall 指针——身份只存在于 async-subagent-runs/<runId>/
  // status.json。上面的 pointers() 永远发现不了它们（R-* 需求：运行中子代理持续
  // 可见 + 关闭拦截）。按 sessionId 归属把当前会话的活跃 run 投影成同构快照；
  // renderer projectSubagents 的无锚 recovered 分支会渲染成卡片，零渲染层改动。
  // covered 含两层：父 runId + workflowRows 里每个 child 的 runId——workflow 的
  // 子 run 目录同样位于 async root 下（resolveWorkflowPointer 已按 child.runId
  // 读它们做终态校正），不纳入 covered 会把已被指针覆盖的子 run 再投影一遍。
  // covered 三层：全量历史 runId（防窗口外老 run 被 orphan 捞回）+ 窗口内快照的
  // 父/子 runId（resolveWorkflowPointer 已按 child.runId 读盘校正，不重复投影）。
  const covered = allPointers().coverage;
  for (const o of output) {
    const d = obj(o.details);
    if (typeof d?.runId === 'string' && workflowId(d.runId)) covered.add(d.runId);
    for (const row of workflowRows(d ?? {})) if (workflowId(row.runId)) covered.add(row.runId);
  }
  output.push(...await orphanAsyncRuns(history, root, now, budget, covered));
  return output;
}

/** Orphan async runs: active (or recently finished) runs owned by THIS session's
 *  path that no history pointer covers. Bounded scan + mtime-cached reads; the
 *  fresh window for terminal states keeps completed cards visible long enough to
 *  be seen, then lets async retention reclaim the directory. */
const MAX_ORPHANS = 8;
const MAX_ORPHAN_SCAN = 64;
const ORPHAN_TAIL_MS = 10 * 60 * 1000;
async function orphanAsyncRuns(history: PiHistory, root: string, now: number, budget: { bytes: number }, covered: Set<string>): Promise<SubagentSnapshot[]> {
  const runs: SubagentSnapshot[] = [];
  let entries: import('node:fs').Dirent[];
  try { entries = await fs.promises.readdir(root, { withFileTypes: true }); } catch { return runs; }
  let scanned = 0;
  for (const entry of entries) {
    if (++scanned > MAX_ORPHAN_SCAN) break; // 扫描上限独立于截断：先全量收集再按新近度选
    if (!entry.isDirectory() || !workflowId(entry.name) || covered.has(entry.name)) continue;
    let status: Record<string, any>;
    try { status = await readSnapshotJsonCached(root, path.join(root, entry.name, 'status.json'), budget); } catch { continue; }
    if (!obj(status) || status.runId !== entry.name) continue;
    // 身份锚：只有 status.sessionId（父会话文件路径）与当前会话一致才归属这里。
    if (status.sessionId !== history.session.path) continue;
    // workflow 子 run：归属由父工作流卡片承担（parentWorkflowRunId 已知即跳过），
    // 单独投影会与父卡片的 children 重复。
    if (typeof status.parentWorkflowRunId === 'string' && status.parentWorkflowRunId) continue;
    const startedAt = Number(status.startedAt), lastUpdate = Number(status.lastUpdate);
    if (!Number.isFinite(startedAt) || !Number.isFinite(lastUpdate) || lastUpdate < startedAt || lastUpdate > now + 60_000) continue;
    // 新鲜窗口（10min）是硬约束：终态超窗不投影（等 retention 清盘），running/queued
    // 幽灵降级 unknown 后同样受它约束——pi-subagents 正常运行时 lastUpdate 持续推进，
    // 超 10min 没动静的 unknown 就是死 run（进程没了/目录残留），永驻只会污染列表
    // （code-review 探针 D2：4h 前幽灵永驻）。
    if (now - lastUpdate > ORPHAN_TAIL_MS) continue;
    let state = workflowState(singleRunRow(status).state);
    if (['running', 'queued'].includes(state) && now - (Number(status.lastUpdate) || 0) > STALE_MS) state = 'unknown';
    // workflow 孤儿按 status 自带 children 投多子卡（singleRunRow 只读 steps[0]，
    // 多子任务会丢——code-review 探针 B）；single 退回单行。
    const rows = status.mode === 'workflow' ? workflowRows(status).slice(0, MAX_CHILDREN) : [];
    const children: Record<string, any>[] = rows.length ? rows.map(row => {
      const c: Record<string, any> = { childId: row.childId, runId: workflowId(row.runId) ? row.runId : undefined, agent: text(row.agent), label: text(row.label), sessionName: text(row.sessionName), state: workflowState(row.state), model: text(row.model) };
      if (typeof row.tokens === 'number') c.tokens = row.tokens;
      if (typeof row.turns === 'number') c.turns = row.turns;
      c.snapshotAt = row.snapshotAt || lastUpdate;
      return c;
    }) : [(() => {
      const row = singleRunRow(status);
      const c: Record<string, any> = { childId: row.childId, runId: workflowId(row.runId) ? row.runId : undefined, agent: text(row.agent), label: text(row.label), sessionName: text(row.sessionName), state, model: text(row.model) };
      if (typeof row.tokens === 'number') c.tokens = row.tokens;
      if (typeof row.turns === 'number') c.turns = row.turns;
      c.snapshotAt = row.snapshotAt || lastUpdate;
      return c;
    })()];
    // detail 与 resolveWorkflowPointer 同构：callId=runId 过 workflowId 校验；
    // toolCallId 同 runId 让 workflowDetails(rec.details, rec.callId) 命中。
    const detail = { mode: 'workflow', runId: entry.name, toolCallId: entry.name, state, snapshotAt: lastUpdate, workflowChildren: { version: 1, parentToolCallId: entry.name, workflowRunId: entry.name, inventoryComplete: true, workflowState: state, children } };
    runs.push({ callId: entry.name, status: 'unknown', details: detail, startedAt, updatedAt: lastUpdate });
  }
  // MAX_ORPHANS 按新近度截断（readdir 目录序不稳定——code-review 探针 C：累积 >8 个
  // 目录时正在运行的最新 run 被丢，可见性需求恰好失败）。
  runs.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return runs.slice(0, MAX_ORPHANS);
}

/** Single runs publish live sessionFile on their only step; the top-level field
 *  may appear only when the run settles. Never guess among multiple steps. */
function singleSessionFile(status: Record<string, any>): string | undefined {
  if (typeof status.sessionFile === 'string' && status.sessionFile) return status.sessionFile;
  if (status.mode !== 'single' || !Array.isArray(status.steps) || status.steps.length !== 1) return undefined;
  const file = obj(status.steps[0])?.sessionFile;
  return typeof file === 'string' && file ? file : undefined;
}

/** Resolve a child run's session file through the SAME validated pointer chain as
 *  workflowSnapshots (containment + identity + time). Returns undefined on any
 *  mismatch; the caller must still containment-check the path against the trusted
 *  sessions root before reading. Never returns filesystem pointers to the renderer. */
export async function childSessionPointer(history: PiHistory, persisted: SubagentSnapshot[], callId: string, childId: string, root = subagentAsyncRoot(), now = Date.now()): Promise<string | undefined> {
  if (!workflowId(callId) || !workflowId(childId)) return undefined;
  // 单次调用（详情面板按需），成本无所谓；语义保持「pinned 穿透尾窗」。
  const pointer = pointers(history, persisted, callId).window.find(p => p.callId === callId);
  if (!pointer) return undefined;
  const d = obj(pointer.details)!;
  const runId = d.runId;
  if (!workflowId(runId)) return undefined;
  const validTime = (s: any) => Number.isFinite(s.startedAt) && Number.isFinite(s.lastUpdate) && s.lastUpdate >= s.startedAt && s.lastUpdate <= now + 60_000 && (!pointer.startedAt || s.startedAt >= pointer.startedAt - 60_000);
  try {
    const expectedDir = path.join(root, runId);
    if (typeof d.asyncDir !== 'string' || path.resolve(d.asyncDir) !== path.resolve(expectedDir) || (d.asyncId !== undefined && d.asyncId !== runId)) return undefined;
    const status = await readSnapshotJsonCached(root, path.join(expectedDir, 'status.json'));
    if (status.runId !== runId || status.sessionId !== history.session.path || !validTime(status)) return undefined;
    if (singleAsyncDetails(d, callId) || completionsDetails(d, callId)) {
      // completions 形态：指针由 completions[].results[].sessionFile 直接给出（run 已结束、
      // async 目录可能已清），不再走 expectedDir/status.json 校验链。
      const fromCompletions = completionsDetails(d, callId);
      if (fromCompletions) return fromCompletions.sessionFile;
      if (status.mode !== 'single' || (status.toolCallId !== undefined && status.toolCallId !== callId) || childId !== 'single') return undefined;
      return singleSessionFile(status);
    }
    if (status.mode !== 'workflow' || status.toolCallId !== callId || !workflowDetails(status, callId)) return undefined;
    const row = workflowRows(status).find(r => r.childId === childId);
    if (!row || !workflowId(row.runId)) return undefined;
    const s = await readSnapshotJsonCached(root, path.join(root, row.runId, 'status.json'));
    if (s.runId !== row.runId || s.sessionId !== history.session.path || !workflowId(s.toolCallId) || s.parentWorkflowRunId !== runId || s.workflowKey !== childId || !validTime(s) || s.startedAt < status.startedAt) return undefined;
    // pi-subagents child runs may omit sessionFile from their own status.json.
    // Fall back to the parent workflow's steps[].sessionFile (set at launch time).
    const sessionFile = singleSessionFile(s);
    if (sessionFile) return sessionFile;
    const step = Array.isArray(status.steps) ? status.steps.find((st: any) => obj(st)?.workflowKey === childId) : undefined;
    const stepFile = obj(step)?.sessionFile;
    return typeof stepFile === 'string' ? stepFile : undefined;
  } catch { return undefined; }
}
