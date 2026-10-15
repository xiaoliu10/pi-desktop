import fs from 'node:fs';
import path from 'node:path';
import type { SessionIndex } from './session-index';
import { childSessionPointer, readSnapshotJson, workflowSnapshots, type SubagentSnapshot } from './subagent-snapshots';
import { singleAsyncDetails, workflowDetails, workflowId, workflowState } from '../../shared/subagent-workflow';

/**
 * Detect whether a third-party subagent extension/package is installed.
 * Desktop's fallback subagent loads via -e ONLY when this returns false.
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
export function officialSubagentStatus(agentDir: string) {
  const thirdParty = detectThirdPartySubagent(agentDir);
  const oldDir = path.join(agentDir, 'extensions', 'desktop-official-subagent');
  const outdated = fs.existsSync(oldDir);
  const scout = path.join(agentDir, 'agents', 'desktop-scout.md');
  return {
    installed: !thirdParty.detected,        // desktop fallback is active when no third-party present
    thirdParty: thirdParty.detected,
    thirdPartySource: thirdParty.source,
    outdated,                               // old extension still in agentDir/extensions/ (needs migration)
    scoutExists: fs.existsSync(scout),
    path: path.join(agentDir, 'extensions', 'desktop-official-subagent', 'index.ts'),
  };
}

/**
 * Enable desktop's subagent support: create the scout agent definition.
 * The fallback extension itself is loaded via -e in backend.launch(), not from disk.
 * This is idempotent and safe to call repeatedly.
 */
export function enableOfficialSubagent(agentDir: string) {
  migrateOldSubagentExtension(agentDir);
  const agentRoot = path.join(agentDir, 'agents');
  fs.mkdirSync(agentRoot, { recursive: true });
  const scout = path.join(agentRoot, 'desktop-scout.md');
  if (!fs.existsSync(scout)) {
    fs.writeFileSync(scout, '---\nname: desktop-scout\ndescription: 只读检查项目并汇总发现\ntools: read, grep, find, ls\n---\n你是只读研究助手。检查任务涉及的代码，报告结论、证据和不确定性。不要修改文件。\n', { mode: 0o600 });
  }
  return { path: scout, upgraded: true };
}

/** Recover only the selected, trusted session/branch. No renderer-supplied paths. */
export async function recoverSubagents(agentDir: string, sessionKey: string, index: Pick<SessionIndex, 'subagentHistory'>, leaf?: string): Promise<SubagentSnapshot[]> {
  if (!/^[a-f0-9]{64}$/.test(sessionKey) || (leaf !== undefined && typeof leaf !== 'string')) return [];
  let history;
  try { history = index.subagentHistory(sessionKey, leaf); } catch { return []; }
  const persisted = await readPersistedSnapshots(agentDir, sessionKey);
  const workflows = await workflowSnapshots(history, persisted);
  // single-async records are already normalized into `workflows`; leaving them in
  // legacy would duplicate the callId and let the raw record shadow the snapshot.
  const legacy = persisted.filter(rec => !workflowDetails(rec.details, rec.callId) && !singleAsyncDetails(rec.details, rec.callId));
  return [...legacy, ...workflows];
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
      if (block.type === 'thinking') return { type: 'thinking', thinking: '[子代理详情省略思考内容]' };
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
export async function subagentChildTranscript(agentDir: string, sessionKey: string, index: Pick<SessionIndex, 'subagentHistory'>, callId: string, childId: string): Promise<{ messages: Record<string, unknown>[]; truncated: boolean } | { error: string }> {
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
    const tail = Math.min(stat.size, TRANSCRIPT_TAIL_BYTES);
    const buffer = Buffer.alloc(tail);
    const { bytesRead } = await handle.read(buffer, 0, tail, stat.size - tail);
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    if (tail < stat.size) text = text.slice(text.indexOf('\n') + 1); // drop partial line
    const messages: Record<string, unknown>[] = [];
    let total = 0;
    for (const line of text.split('\n')) {
      if (!line) continue;
      let entry: any;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry?.type === 'message' && entry.message && typeof entry.message.role === 'string') { total++; messages.push(sanitizeTranscriptMessage(entry.message)); }
    }
    const out = messages.slice(-TRANSCRIPT_MESSAGES);
    return { messages: out, truncated: total > out.length || tail < stat.size };
  } catch { return { error: 'read-failed' }; }
  finally { if (handle) await handle.close().catch(() => undefined); }
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
