import fs from 'node:fs';
import path from 'node:path';
import type { SessionIndex } from './session-index';
import { readSnapshotJson, workflowSnapshots, type SubagentSnapshot } from './subagent-snapshots';
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
  const dir = path.join(agentDir, 'subagents');
  const persisted: SubagentSnapshot[] = [];
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
  const workflows = await workflowSnapshots(history, persisted);
  // single-async records are already normalized into `workflows`; leaving them in
  // legacy would duplicate the callId and let the raw record shadow the snapshot.
  const legacy = persisted.filter(rec => !workflowDetails(rec.details, rec.callId) && !singleAsyncDetails(rec.details, rec.callId));
  return [...legacy, ...workflows];
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
