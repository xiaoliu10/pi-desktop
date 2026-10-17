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
const STALE_MS = 5 * 60 * 1000;

export function subagentAsyncRoot(): string {
  const sanitize = (s: string) => s.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
  const scope = typeof process.getuid === 'function' ? `uid-${process.getuid()}` : `user-${sanitize(process.env.USERNAME || process.env.USER || os.userInfo().username)}`;
  return process.env.PI_SUBAGENTS_TEMP_ROOT?.trim() ? path.resolve(process.env.PI_SUBAGENTS_TEMP_ROOT.trim(), 'async-subagent-runs') : path.join(os.tmpdir(), `pi-subagents-${scope}`, 'async-subagent-runs');
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
 *  bounded scan for list rendering while making per-card reads always resolvable. */
function pointers(history: PiHistory, persisted: SubagentSnapshot[], pinned?: string) {
  const calls = new Map<string, { at: number; management: boolean }>();
  const found = new Map<string, SubagentSnapshot>();
  const collect = (details: unknown, callId: string, at?: number) => {
    if (workflowDetails(details, callId) || singleAsyncDetails(details, callId) || completionsDetails(details, callId)) found.set(callId, { callId, status: 'unknown', details, startedAt: at });
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
  }
  const all = [...found.values()];
  const window = all.slice(-MAX_CALLS);
  if (pinned && workflowId(pinned) && !window.some(p => p.callId === pinned)) {
    const hit = all.find(p => p.callId === pinned);
    // Replace the oldest window entry rather than growing it: list rendering stays
    // bounded; the pinned card is what the user is looking at right now.
    if (hit) { window.shift(); window.push(hit); }
  }
  return window;
}

/** Main-process-only adapter. No scans, no session/transcript/prompt reads and no
 * returned filesystem pointers. The caller supplies trusted selected-branch history. */
export async function workflowSnapshots(history: PiHistory, persisted: SubagentSnapshot[], root = subagentAsyncRoot(), now = Date.now()): Promise<SubagentSnapshot[]> {
  const budget = { bytes: MAX_BYTES };
  const output: SubagentSnapshot[] = [];
  for (const pointer of pointers(history, persisted)) {
    const d = obj(pointer.details)!;
    const runId = d.runId;
    const isSingle = !!singleAsyncDetails(d, pointer.callId);
    let detail: Record<string, any> = { mode: 'workflow', runId, toolCallId: pointer.callId, state: 'unknown', steps: [] };
    let updatedAt = 0;
    try {
      const expectedDir = path.join(root, runId);
      if (typeof d.asyncDir !== 'string' || path.resolve(d.asyncDir) !== path.resolve(expectedDir) || (d.asyncId !== undefined && d.asyncId !== runId)) throw new Error('invalid async pointer');
      const status = await readSnapshotJson(root, path.join(expectedDir, 'status.json'), budget);
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
              const s = await readSnapshotJson(root, path.join(root, child.runId, 'status.json'), budget);
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
    output.push({ callId: pointer.callId, status: detail.state, details: detail, updatedAt });
  }
  return output;
}

/** Resolve a child run's session file through the SAME validated pointer chain as
 *  workflowSnapshots (containment + identity + time). Returns undefined on any
 *  mismatch; the caller must still containment-check the path against the trusted
 *  sessions root before reading. Never returns filesystem pointers to the renderer. */
export async function childSessionPointer(history: PiHistory, persisted: SubagentSnapshot[], callId: string, childId: string, root = subagentAsyncRoot(), now = Date.now()): Promise<string | undefined> {
  if (!workflowId(callId) || !workflowId(childId)) return undefined;
  const pointer = pointers(history, persisted, callId).find(p => p.callId === callId);
  if (!pointer) return undefined;
  const d = obj(pointer.details)!;
  const runId = d.runId;
  if (!workflowId(runId)) return undefined;
  const validTime = (s: any) => Number.isFinite(s.startedAt) && Number.isFinite(s.lastUpdate) && s.lastUpdate >= s.startedAt && s.lastUpdate <= now + 60_000 && (!pointer.startedAt || s.startedAt >= pointer.startedAt - 60_000);
  try {
    const expectedDir = path.join(root, runId);
    if (typeof d.asyncDir !== 'string' || path.resolve(d.asyncDir) !== path.resolve(expectedDir) || (d.asyncId !== undefined && d.asyncId !== runId)) return undefined;
    const status = await readSnapshotJson(root, path.join(expectedDir, 'status.json'));
    if (status.runId !== runId || status.sessionId !== history.session.path || !validTime(status)) return undefined;
    if (singleAsyncDetails(d, callId) || completionsDetails(d, callId)) {
      // completions 形态：指针由 completions[].results[].sessionFile 直接给出（run 已结束、
      // async 目录可能已清），不再走 expectedDir/status.json 校验链。
      const fromCompletions = completionsDetails(d, callId);
      if (fromCompletions) return fromCompletions.sessionFile;
      if (status.mode !== 'single' || (status.toolCallId !== undefined && status.toolCallId !== callId) || childId !== 'single') return undefined;
      return typeof status.sessionFile === 'string' ? status.sessionFile : undefined;
    }
    if (status.mode !== 'workflow' || status.toolCallId !== callId || !workflowDetails(status, callId)) return undefined;
    const row = workflowRows(status).find(r => r.childId === childId);
    if (!row || !workflowId(row.runId)) return undefined;
    const s = await readSnapshotJson(root, path.join(root, row.runId, 'status.json'));
    if (s.runId !== row.runId || s.sessionId !== history.session.path || !workflowId(s.toolCallId) || s.parentWorkflowRunId !== runId || s.workflowKey !== childId || !validTime(s) || s.startedAt < status.startedAt) return undefined;
    // pi-subagents child runs may omit sessionFile from their own status.json.
    // Fall back to the parent workflow's steps[].sessionFile (set at launch time).
    if (typeof s.sessionFile === 'string') return s.sessionFile;
    const step = Array.isArray(status.steps) ? status.steps.find((st: any) => obj(st)?.workflowKey === childId) : undefined;
    const stepFile = obj(step)?.sessionFile;
    return typeof stepFile === 'string' ? stepFile : undefined;
  } catch { return undefined; }
}
