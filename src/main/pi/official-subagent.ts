import fs from 'node:fs';
import path from 'node:path';

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

/** Read persisted subagent files for a session (recovery after parent restart). */
export function recoverSubagents(agentDir: string, sessionKey: string): Array<{ callId: string; status: string; details?: unknown; error?: string; startedAt?: number; updatedAt?: number }> {
  const dir = path.join(agentDir, 'subagents');
  if (!fs.existsSync(dir)) return [];
  const prefix = sessionKey + '_';
  const files = fs.readdirSync(dir).filter(f => f.startsWith(prefix) && f.endsWith('.json'));
  return files.map(f => {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (data.status === 'completed') {
        try { fs.unlinkSync(path.join(dir, f)); } catch {}
        return null;
      }
      return data;
    } catch { return null; }
  }).filter(Boolean) as any;
}

/** Clean up all persisted subagent files for a session (on disconnect/close). */
export function cleanupSubagents(agentDir: string, sessionKey: string) {
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
  const dir = path.join(agentDir, 'subagents');
  const file = path.join(dir, `${sessionKey}_${callId}.json`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const details = event.partialResult?.details ?? event.result?.details;
    const status = event.type === 'tool_execution_end' ? 'completed' : 'running';
    const payload: Record<string, unknown> = { callId, startedAt: Date.now(), status, updatedAt: Date.now() };
    if (details) payload.details = details;
    if (event.type === 'tool_execution_end' && event.result?.isError) payload.status = 'failed';
    fs.writeFileSync(file, JSON.stringify(payload), { mode: 0o600 });
    // Clean up on success after 5s (session file is source of truth)
    if (status === 'completed') {
      setTimeout(() => { try { fs.unlinkSync(file); } catch {} }, 5000).unref?.();
    }
  } catch { /* best-effort */ }
}
