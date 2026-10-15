import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSnapshotJson, subagentAsyncRoot, workflowSnapshots, type SubagentSnapshot } from '../src/main/pi/subagent-snapshots';
import { workflowDetails } from '../src/shared/subagent-workflow';
import type { PiHistory } from '../src/shared/pi';

const validRunId = 'e6f11763-f8af-48f1-bcf4-858039b38d5d';
const childRunId = 'a926326f-6e89-4410-a940-e926e799cf64';
const parentSessionFile = '/Users/jason/.pi/agent/sessions/desktop/1790689427762_5e3a1092-dba8-42cc-bf5a-921db5534717.jsonl';

function makeHistory(sessionPath: string, branch: any[] = []): PiHistory {
  const session = { key: 'abc123', id: 'sid', path: sessionPath, cwd: '/x', name: 'test', updatedAt: 0, size: 0, warnings: [], owned: true };
  return { session, entries: branch, branch, leaves: [], leafId: null, syncedAt: Date.now() };
}

function makePointerHistory(callId: string, runId: string, sessionPath: string, asyncRoot?: string): PiHistory {
  const root = asyncRoot ?? subagentAsyncRoot();
  const toolCall = { type: 'message', id: 'm1', message: { role: 'assistant', content: [{ type: 'toolCall', id: callId, name: 'subagent', arguments: { agent: 'frontend-developer' } }] }, timestamp: new Date().toISOString() };
  const toolResult = { type: 'message', id: 'm2', message: { role: 'toolResult', toolCallId: callId, toolName: 'subagent', content: [], details: { mode: 'workflow', runId, toolCallId: callId, asyncId: runId, asyncDir: `${root}/${runId}`, results: [], workflowChildren: { version: 1, parentToolCallId: callId, workflowRunId: runId, inventoryComplete: false, workflowState: 'running', children: [] }, chatProgress: { mode: 'off' } } } };
  return makeHistory(sessionPath, [toolCall, toolResult]);
}

describe('readSnapshotJson security', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-snap-test-')); });
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

  it('reads a valid contained JSON file', async () => {
    const file = path.join(root, 'test.json');
    fs.writeFileSync(file, JSON.stringify({ ok: true }));
    const data = await readSnapshotJson(root, file);
    expect(data).toEqual({ ok: true });
  });
  it('rejects paths outside root (path traversal)', async () => {
    const outside = path.join(os.tmpdir(), 'outside-test.json');
    fs.writeFileSync(outside, JSON.stringify({ hack: true }));
    try {
      await expect(readSnapshotJson(root, outside)).rejects.toThrow();
    } finally { fs.unlinkSync(outside); }
  });
  it('rejects symlinks', async () => {
    const target = path.join(root, 'target.json');
    fs.writeFileSync(target, JSON.stringify({ real: true }));
    const link = path.join(root, 'link.json');
    fs.symlinkSync(target, link);
    await expect(readSnapshotJson(root, link)).rejects.toThrow();
  });
  it('rejects oversized files', async () => {
    const file = path.join(root, 'big.json');
    fs.writeFileSync(file, 'x'.repeat(256 * 1024 + 1));
    await expect(readSnapshotJson(root, file)).rejects.toThrow();
  });
  it('rejects non-JSON content', async () => {
    const file = path.join(root, 'bad.txt');
    fs.writeFileSync(file, 'not json at all');
    await expect(readSnapshotJson(root, file)).rejects.toThrow();
  });
  it('rejects directories', async () => {
    const dir = path.join(root, 'subdir');
    fs.mkdirSync(dir);
    await expect(readSnapshotJson(root, dir)).rejects.toThrow();
  });
});

describe('workflowSnapshots integration', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-snap-int-')); });
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

  function writeStatus(runId: string, status: Record<string, any>) {
    const dir = path.join(root, runId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(status));
  }

  it('reads a running workflow + child snapshot', async () => {
    const now = Date.now();
    writeStatus(validRunId, {
      runId: validRunId, toolCallId: 'call-1', sessionId: parentSessionFile, mode: 'workflow', state: 'running', startedAt: now - 10000, lastUpdate: now - 1000,
      workflowChildren: { version: 1, parentToolCallId: 'call-1', workflowRunId: validRunId, inventoryComplete: true, workflowState: 'running', children: [{ childId: 'fix-bug', runId: childRunId, agent: 'frontend-developer', state: 'running' }] },
    });
    writeStatus(childRunId, {
      runId: childRunId, sessionId: parentSessionFile, mode: 'single', state: 'running', startedAt: now - 9000, lastUpdate: now - 500, parentWorkflowRunId: validRunId, workflowKey: 'fix-bug', toolCallId: 'ef9c8729', turnCount: 5, totalTokens: { total: 1000 },
    });
    const history = makePointerHistory('call-1', validRunId, parentSessionFile, root);
    const snapshots = await workflowSnapshots(history, [], root, now);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].callId).toBe('call-1');
    const w = workflowDetails(snapshots[0].details, 'call-1')!;
    expect(w.state).toBe('running');
    expect(w.workflowChildren.children).toHaveLength(1);
    expect(w.workflowChildren.children[0]).toMatchObject({ childId: 'fix-bug', state: 'running', model: expect.any(String) });
    expect(w.workflowChildren.children[0]).not.toHaveProperty('sessionFile');
    expect(w.workflowChildren.children[0]).not.toHaveProperty('transcriptPath');
  });
  it('rejects snapshot with mismatched sessionId (wrong session)', async () => {
    const now = Date.now();
    writeStatus(validRunId, { runId: validRunId, toolCallId: 'call-1', sessionId: '/wrong/path.jsonl', mode: 'workflow', state: 'running', startedAt: now - 1000, lastUpdate: now, workflowChildren: { version: 1, parentToolCallId: 'call-1', workflowRunId: validRunId, inventoryComplete: true, workflowState: 'running', children: [] } });
    const history = makePointerHistory('call-1', validRunId, parentSessionFile, root);
    const snapshots = await workflowSnapshots(history, [], root, now);
    expect(snapshots[0].status).toBe('unknown'); // rejected → unknown
  });
  it('rejects snapshot with mismatched toolCallId', async () => {
    const now = Date.now();
    writeStatus(validRunId, { runId: validRunId, toolCallId: 'other-call', sessionId: parentSessionFile, mode: 'workflow', state: 'running', startedAt: now - 1000, lastUpdate: now, workflowChildren: { version: 1, parentToolCallId: 'other-call', workflowRunId: validRunId, inventoryComplete: true, workflowState: 'running', children: [] } });
    const history = makePointerHistory('call-1', validRunId, parentSessionFile, root);
    const snapshots = await workflowSnapshots(history, [], root, now);
    expect(snapshots[0].status).toBe('unknown');
  });
  it('marks stale running as unknown after 5min', async () => {
    const now = Date.now();
    writeStatus(validRunId, { runId: validRunId, toolCallId: 'call-1', sessionId: parentSessionFile, mode: 'workflow', state: 'running', startedAt: now - 600000, lastUpdate: now - 400000, workflowChildren: { version: 1, parentToolCallId: 'call-1', workflowRunId: validRunId, inventoryComplete: false, workflowState: 'running', children: [] } });
    const history = makePointerHistory('call-1', validRunId, parentSessionFile, root);
    const snapshots = await workflowSnapshots(history, [], root, now);
    const w = workflowDetails(snapshots[0].details, 'call-1')!;
    expect(w.state).toBe('unknown'); // stale → unknown, not running
  });
  it('handles corrupt status.json gracefully', async () => {
    const dir = path.join(root, validRunId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'status.json'), '{corrupt json');
    const history = makePointerHistory('call-1', validRunId, parentSessionFile, root);
    const snapshots = await workflowSnapshots(history, [], root);
    expect(snapshots[0].status).toBe('unknown');
  });
  it('handles missing status.json gracefully', async () => {
    const history = makePointerHistory('call-1', validRunId, parentSessionFile, root);
    const snapshots = await workflowSnapshots(history, [], root);
    expect(snapshots[0].status).toBe('unknown');
  });
  it('does not read child transcript/session/prompt files', async () => {
    const now = Date.now();
    writeStatus(validRunId, {
      runId: validRunId, toolCallId: 'call-1', sessionId: parentSessionFile, mode: 'workflow', state: 'running', startedAt: now - 10000, lastUpdate: now - 1000,
      workflowChildren: { version: 1, parentToolCallId: 'call-1', workflowRunId: validRunId, inventoryComplete: true, workflowState: 'running', children: [{ childId: 'fix-bug', runId: childRunId, agent: 'dev', state: 'running' }] },
    });
    // Write a child status that has sessionFile + transcriptPath fields
    writeStatus(childRunId, {
      runId: childRunId, sessionId: parentSessionFile, mode: 'single', state: 'running', startedAt: now - 9000, lastUpdate: now - 500, parentWorkflowRunId: validRunId, workflowKey: 'fix-bug', toolCallId: 'ef9c8729',
      sessionFile: '/secret/session.jsonl', transcriptPath: '/secret/transcript.jsonl', steps: [{ task: '[prompt redacted]', model: 'test-model', description: '[prompt redacted]' }],
    });
    const history = makePointerHistory('call-1', validRunId, parentSessionFile, root);
    const snapshots = await workflowSnapshots(history, [], root, now);
    const w = workflowDetails(snapshots[0].details, 'call-1')!;
    const child = w.workflowChildren.children[0];
    expect(child).not.toHaveProperty('sessionFile');
    expect(child).not.toHaveProperty('transcriptPath');
    expect(child).not.toHaveProperty('task');
    expect(child).not.toHaveProperty('description');
    expect(child).not.toHaveProperty('recentOutput');
    expect(child).not.toHaveProperty('prompt');
    // model from step[0] is allowed (display field only)
    expect(child.model).toBe('test-model');
  });
  it('completed child and completed workflow', async () => {
    const now = Date.now();
    writeStatus(validRunId, {
      runId: validRunId, toolCallId: 'call-1', sessionId: parentSessionFile, mode: 'workflow', state: 'completed', startedAt: now - 10000, lastUpdate: now - 1000,
      workflowChildren: { version: 1, parentToolCallId: 'call-1', workflowRunId: validRunId, inventoryComplete: true, workflowState: 'completed', children: [{ childId: 'fix-bug', runId: childRunId, agent: 'dev', state: 'completed' }] },
    });
    writeStatus(childRunId, { runId: childRunId, sessionId: parentSessionFile, mode: 'single', state: 'completed', startedAt: now - 9000, lastUpdate: now - 500, parentWorkflowRunId: validRunId, workflowKey: 'fix-bug', toolCallId: 'ef9c8729', totalTokens: { total: 5000 }, turnCount: 10 });
    const history = makePointerHistory('call-1', validRunId, parentSessionFile, root);
    const snapshots = await workflowSnapshots(history, [], root, now);
    const w = workflowDetails(snapshots[0].details, 'call-1')!;
    expect(w.state).toBe('completed');
    expect(w.workflowChildren.children[0].state).toBe('completed');
    expect(w.workflowChildren.children[0].tokens).toBe(5000);
  });
});

describe('subagentAsyncRoot', () => {
  it('respects PI_SUBAGENTS_TEMP_ROOT env', () => {
    const orig = process.env.PI_SUBAGENTS_TEMP_ROOT;
    process.env.PI_SUBAGENTS_TEMP_ROOT = '/custom/temp';
    try {
      expect(subagentAsyncRoot()).toBe(path.resolve('/custom/temp/async-subagent-runs'));
    } finally { process.env.PI_SUBAGENTS_TEMP_ROOT = orig; }
  });
  it('defaults to tmpdir with uid scope', () => {
    const orig = process.env.PI_SUBAGENTS_TEMP_ROOT;
    delete process.env.PI_SUBAGENTS_TEMP_ROOT;
    try {
      const root = subagentAsyncRoot();
      expect(root).toContain('pi-subagents-');
      expect(root).toContain('async-subagent-runs');
    } finally { process.env.PI_SUBAGENTS_TEMP_ROOT = orig; }
  });
});
