import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AsyncSubagentActivity } from '../src/main/pi/async-subagent-activity';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })); });
const NOW = 1_700_000_000_000;
const sessions = [{ key: 'a'.repeat(64), file: '/sessions/a.jsonl' }, { key: 'b'.repeat(64), file: '/sessions/b.jsonl' }];
function setup() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'async-activity-')));
  roots.push(root);
  const write = (id: string, over: Record<string, unknown> = {}) => {
    fs.mkdirSync(path.join(root, id), { recursive: true });
    fs.writeFileSync(path.join(root, id, 'status.json'), JSON.stringify({ mode: 'single', runId: id, sessionId: sessions[0].file,
      state: 'running', startedAt: NOW - 60_000, lastUpdate: NOW - 1_000, toolCallId: 'call-' + id, ...over }));
  };
  return { root, write, activity: new AsyncSubagentActivity() };
}

describe('async subagent activity for sidebar', () => {
  it('keeps an idle parent busy while async children run, then clears on terminal state without parent RPC events', async () => {
    const { root, write, activity } = setup();
    write('one'); write('two', { state: 'queued' });
    const first = await activity.scan(root, sessions, NOW);
    expect(first.counts).toEqual({ [sessions[0].key]: 2 });
    write('one', { state: 'complete' }); write('two', { state: 'failed' });
    const end = await activity.scan(root, sessions, NOW);
    expect(end.counts).toEqual({});
    expect(end.observedCalls.has(sessions[0].key + ':call-one')).toBe(true);
  });

  it('counts children once, not both the workflow and its children; fresh children survive an old workflow timestamp', async () => {
    const { root, write, activity } = setup();
    write('workflow', { mode: 'workflow', startedAt: NOW - 600_000, lastUpdate: NOW - 500_000,
      workflowChildren: { version: 1, parentToolCallId: 'call-workflow', workflowRunId: 'workflow', children: [
        { childId: 'c1', runId: 'one', state: 'running' }, { childId: 'c2', runId: 'two', state: 'running' },
      ] } });
    write('one', { parentWorkflowRunId: 'workflow' });
    write('two', { parentWorkflowRunId: 'workflow', state: 'complete' });
    expect((await activity.scan(root, sessions, NOW)).counts).toEqual({ [sessions[0].key]: 1 });
  });

  it('uses inventory rows when a fresh workflow has no separate child status yet', async () => {
    const { root, write, activity } = setup();
    write('workflow', { mode: 'workflow', workflowChildren: { version: 1, parentToolCallId: 'call-workflow', workflowRunId: 'workflow', children: [
      { childId: 'c1', runId: 'one', state: 'running' }, { childId: 'c2', state: 'queued' }, { childId: 'c3', state: 'completed' },
    ] } });
    expect((await activity.scan(root, sessions, NOW)).counts).toEqual({ [sessions[0].key]: 2 });
  });

  it('isolates sessions and rejects stale, future, corrupt, mismatched and symlinked records', async () => {
    const { root, write, activity } = setup();
    write('other', { sessionId: sessions[1].file });
    write('foreign', { sessionId: '/sessions/foreign.jsonl' });
    write('stale', { startedAt: NOW - 600_000, lastUpdate: NOW - 400_000 });
    write('future', { lastUpdate: NOW + 120_000 });
    write('mismatch', { runId: 'different' });
    write('broken'); fs.writeFileSync(path.join(root, 'broken', 'status.json'), '{');
    write('linked'); fs.renameSync(path.join(root, 'linked'), path.join(root, 'saved')); fs.symlinkSync(path.join(root, 'saved'), path.join(root, 'linked'));
    expect((await activity.scan(root, sessions, NOW)).counts).toEqual({ [sessions[1].key]: 1 });
  });

  it('retains legacy/custom activity but async terminal records suppress frozen launch snapshots', async () => {
    const { root, write, activity } = setup();
    const agentDir = path.join(root, 'agent'), dir = path.join(agentDir, 'subagents');
    fs.mkdirSync(dir, { recursive: true });
    const save = (id: string) => fs.writeFileSync(path.join(dir, sessions[0].key + '_' + id + '.json'), JSON.stringify({ callId: id, status: 'running', updatedAt: NOW }));
    save('call-one'); save('custom'); write('one', { state: 'complete' });
    const result = await activity.scan(root, sessions, NOW, agentDir);
    expect(result.counts).toEqual({});
    expect(result.legacyCounts).toEqual({ [sessions[0].key]: 1 });
  });

  it('reuses unchanged parsed snapshots and never reads transcripts/history; stale expiry still advances', async () => {
    const { root, write, activity } = setup(); write('one');
    await activity.scan(root, sessions, NOW);
    const open = vi.spyOn(fs.promises, 'open');
    expect((await activity.scan(root, sessions, NOW)).counts[sessions[0].key]).toBe(1);
    expect(open).not.toHaveBeenCalled();
    expect((await activity.scan(root, sessions, NOW + 600_000)).counts).toEqual({});
    expect(open).not.toHaveBeenCalled();
  });
});
