import fs from 'node:fs';
import path from 'node:path';
import { readSnapshotJson, STALE_MS } from './subagent-snapshots';
import { workflowId, workflowRows, workflowState } from '../../shared/subagent-workflow';

export interface SubagentActivity {
  counts: Record<string, number>;
  legacyCounts: Record<string, number>;
  /** Async status supersedes the frozen tool-event snapshot, including terminal states. */
  observedCalls: Set<string>;
}

/** Sidebar-only, bounded metadata reader. Never reads session history or transcripts.
 * One shared scan serves all connected sessions; unchanged files reuse parsed JSON.
 * Keep this independent of workflowSnapshots (which resolves selected-branch cards). */
export class AsyncSubagentActivity {
  private cache = new Map<string, { stamp: string; data: Record<string, any> }>();

  async scan(root: string, sessions: Array<{ key: string; file: string }>, now = Date.now(), agentDir?: string): Promise<SubagentActivity> {
    const result: SubagentActivity = { counts: {}, legacyCounts: {}, observedCalls: new Set() };
    if (!sessions.length) return result;
    const byFile = new Map(sessions.map(session => [path.resolve(session.file), session.key]));
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(root, { withFileTypes: true }); }
    catch { entries = []; }
    const candidates = entries.filter(entry => entry.isDirectory() && workflowId(entry.name)).slice(0, 4096);
    const seen = new Set<string>();
    const records = new Map<string, { key: string; status: Record<string, any>; fresh: boolean }>();
    const budget = { bytes: 2 * 1024 * 1024 };
    // Bounded concurrency: async metadata IO cannot monopolize the main thread or flood libuv.
    for (let at = 0; at < candidates.length; at += 16) {
      await Promise.all(candidates.slice(at, at + 16).map(async entry => {
        const dir = path.join(root, entry.name), file = path.join(dir, 'status.json');
        seen.add(file);
        try {
          const [directory, stat] = await Promise.all([fs.promises.lstat(dir), fs.promises.lstat(file)]);
          if (!directory.isDirectory() || directory.isSymbolicLink() || !stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) return;
          const stamp = [directory.dev, directory.ino, directory.ctimeMs, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
          const cached = this.cache.get(file);
          const status = cached?.stamp === stamp ? cached.data : await readSnapshotJson(root, file, budget);
          this.cache.set(file, { stamp, data: status });
          if (status.runId !== entry.name || typeof status.sessionId !== 'string') return;
          const key = byFile.get(path.resolve(status.sessionId));
          if (!key || !['single', 'workflow'].includes(status.mode)) return;
          const started = status.startedAt, updated = status.lastUpdate;
          if (!Number.isFinite(started) || !Number.isFinite(updated) || updated < started || updated > now + 60_000) return;
          const fresh = now - updated <= STALE_MS;
          records.set(entry.name, { key, status, fresh });
          if (workflowId(status.toolCallId)) result.observedCalls.add(key + ':' + status.toolCallId);
        } catch { this.cache.delete(file); /* Missing, unsafe or corrupt status is not a live observation. */ }
      }));
    }
    const live = (state: unknown) => ['running', 'queued'].includes(workflowState(state));
    const identities = new Map<string, Set<string>>();
    const add = (key: string, id: string) => { const ids = identities.get(key) ?? new Set<string>(); ids.add(id); identities.set(key, ids); };
    const parentsWithChildren = new Set([...records.values()].filter(record => typeof record.status.parentWorkflowRunId === 'string').map(record => record.key + ':' + record.status.parentWorkflowRunId));
    for (const [id, record] of records) {
      const { key, status, fresh } = record;
      if (status.mode === 'single') {
        if (fresh && live(status.state ?? status.steps?.[0]?.status)) add(key, id);
        continue;
      }
      // A workflow's own clock may stop while its children keep updating. Separate child
      // records are authoritative; don't count the parent again or resurrect terminal children.
      const rows = workflowRows(status);
      for (const row of rows) {
        const child = typeof row.runId === 'string' ? records.get(row.runId) : undefined;
        if (child && child.key === key) continue;
        if (fresh && live(row.state)) add(key, workflowId(row.runId) ? row.runId : id + ':' + row.childId);
      }
      if (!rows.length && fresh && live(status.state) && !parentsWithChildren.has(key + ':' + id)) add(key, id);
    }
    for (const [key, ids] of identities) if (ids.size) result.counts[key] = ids.size;
    // Legacy/custom synchronous tools still publish event snapshots. Read them asynchronously
    // in this shared tick too; a 3s timer must not reintroduce synchronous main-thread IO.
    if (agentDir) {
      const dir = path.join(agentDir, 'subagents'), keys = new Set(sessions.map(session => session.key));
      let legacy: fs.Dirent[] = [];
      try { legacy = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { /* Optional directory. */ }
      const files = legacy.filter(entry => entry.isFile() && entry.name.endsWith('.json') && keys.has(entry.name.slice(0, 64)) && entry.name[64] === '_').slice(0, 4096);
      for (let at = 0; at < files.length; at += 16) await Promise.all(files.slice(at, at + 16).map(async entry => {
        const file = path.join(dir, entry.name), key = entry.name.slice(0, 64), callId = entry.name.slice(65, -5);
        seen.add(file);
        if (!workflowId(callId) || result.observedCalls.has(key + ':' + callId)) return;
        try {
          const stat = await fs.promises.lstat(file);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) return;
          const stamp = [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
          const hit = this.cache.get(file);
          const data = hit?.stamp === stamp ? hit.data : await readSnapshotJson(dir, file, budget);
          this.cache.set(file, { stamp, data });
          const updated = data.updatedAt;
          if (data.callId === callId && live(data.status) && Number.isFinite(updated) && updated <= now + 60_000 && now - updated <= STALE_MS) result.legacyCounts[key] = (result.legacyCounts[key] ?? 0) + 1;
        } catch { this.cache.delete(file); }
      }));
    }
    for (const file of this.cache.keys()) if (!seen.has(file)) this.cache.delete(file);
    return result;
  }
}
