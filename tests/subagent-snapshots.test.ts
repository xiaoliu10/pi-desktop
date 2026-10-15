import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { childSessionPointer, readSnapshotJson, subagentAsyncRoot, workflowSnapshots, type SubagentSnapshot } from '../src/main/pi/subagent-snapshots';
import { recoverSubagents, subagentChildTranscript } from '../src/main/pi/official-subagent';
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
  it('reads a detached async SINGLE run as one child from status.json', async () => {
    const now = Date.now();
    const runId = '1e61e2e8-8878-4008-940d-00aee2a8f040';
    writeStatus(runId, {
      runId, toolCallId: 'call-s1', sessionId: parentSessionFile, mode: 'single', state: 'paused', startedAt: now - 30000, lastUpdate: now - 1000,
      steps: [{ agent: 'electron-pro', status: 'paused', model: 'ccr/ccr-opus' }], totalTokens: { total: 111240 }, turnCount: 12, cwd: '/x',
    });
    const toolCall = { type: 'message', id: 'm1', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call-s1', name: 'subagent', arguments: { agent: 'electron-pro' } }] }, timestamp: new Date().toISOString() };
    const toolResult = { type: 'message', id: 'm2', message: { role: 'toolResult', toolCallId: 'call-s1', toolName: 'subagent', content: [], details: { mode: 'single', runId, asyncId: runId, asyncDir: `${root}/${runId}`, results: [] } } };
    const history = makeHistory(parentSessionFile, [toolCall, toolResult]);
    const snapshots = await workflowSnapshots(history, [], root, now);
    expect(snapshots).toHaveLength(1);
    const w = workflowDetails(snapshots[0].details, 'call-s1')!;
    expect(w.state).toBe('interrupted'); // paused → interrupted
    expect(w.workflowChildren.children).toHaveLength(1);
    expect(w.workflowChildren.children[0]).toMatchObject({ childId: 'single', runId, agent: 'electron-pro', model: 'ccr/ccr-opus', state: 'interrupted' });
    expect(w.workflowChildren.children[0].tokens).toBe(111240);
    expect(w.workflowChildren.children[0]).not.toHaveProperty('sessionFile');
  });
  it('binds a revived single run (no toolCallId) by runId + sessionId', async () => {
    const now = Date.now();
    const runId = 'e8dad601-8ba7-45a6-b0b2-96f4dd6d17d2';
    // Revived status.json omits toolCallId (completionOwnerId only) — must still bind.
    writeStatus(runId, {
      runId, sessionId: parentSessionFile, mode: 'single', state: 'complete', startedAt: now - 5000, lastUpdate: now - 500,
      steps: [{ agent: 'electron-pro', status: 'complete', model: 'ccr/ccr-opus' }], totalTokens: { total: 47960 }, turnCount: 2, cwd: '/x',
    });
    const toolCall = { type: 'message', id: 'm1', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call-rev', name: 'subagent', arguments: { agent: 'electron-pro' } }] }, timestamp: new Date().toISOString() };
    // The resume tool result carries the revived runId but the status.json has no toolCallId.
    const toolResult = { type: 'message', id: 'm2', message: { role: 'toolResult', toolCallId: 'call-rev', toolName: 'subagent', content: [], details: { mode: 'single', runId, asyncId: runId, asyncDir: `${root}/${runId}`, results: [] } } };
    const history = makeHistory(parentSessionFile, [toolCall, toolResult]);
    const snapshots = await workflowSnapshots(history, [], root, now);
    const w = workflowDetails(snapshots[0].details, 'call-rev')!;
    expect(w.workflowChildren.children[0].state).toBe('completed');
    expect(w.workflowChildren.children[0].tokens).toBe(47960);
  });
  it('rejects a single snapshot whose sessionId belongs to another session', async () => {
    const now = Date.now();
    const runId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    writeStatus(runId, { runId, toolCallId: 'call-s2', sessionId: '/wrong/session.jsonl', mode: 'single', state: 'running', startedAt: now - 1000, lastUpdate: now, steps: [{ agent: 'x' }] });
    const toolCall = { type: 'message', id: 'm1', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call-s2', name: 'subagent', arguments: {} }] }, timestamp: new Date().toISOString() };
    const toolResult = { type: 'message', id: 'm2', message: { role: 'toolResult', toolCallId: 'call-s2', toolName: 'subagent', content: [], details: { mode: 'single', runId, asyncDir: `${root}/${runId}`, results: [] } } };
    const history = makeHistory(parentSessionFile, [toolCall, toolResult]);
    const snapshots = await workflowSnapshots(history, [], root, now);
    expect(snapshots[0].status).toBe('unknown');
  });
});

describe('recoverSubagents dedupe (single-async legacy shadowing)', () => {
  let agentDir: string;
  beforeEach(() => { agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-recover-test-')); });
  afterEach(() => { try { fs.rmSync(agentDir, { recursive: true, force: true }); } catch {} });

  it('does not duplicate a callId when a raw single-async event snapshot persists', async () => {
    const sessionKey = 'a'.repeat(64);
    const runId = 'cccccccc-dddd-4eee-8fff-000000000001';
    const callId = 'call-dup1';
    // persisted event-level snapshot carries the RAW single-async details
    const subDir = path.join(agentDir, 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, `${sessionKey}_${callId}.json`), JSON.stringify({ callId, status: 'unknown', details: { mode: 'single', runId, asyncId: runId, asyncDir: `/nonexistent/${runId}`, results: [] } }));
    // history contains the same call → workflowSnapshots normalizes it
    const toolCall = { type: 'message', id: 'm1', message: { role: 'assistant', content: [{ type: 'toolCall', id: callId, name: 'subagent', arguments: { agent: 'electron-pro' } }] }, timestamp: new Date().toISOString() };
    const toolResult = { type: 'message', id: 'm2', message: { role: 'toolResult', toolCallId: callId, toolName: 'subagent', content: [], details: { mode: 'single', runId, asyncId: runId, asyncDir: `/nonexistent/${runId}`, results: [] } } };
    const history = makeHistory(parentSessionFile, [toolCall, toolResult]);
    const index = { subagentHistory: () => history } as any;
    const recovered = await recoverSubagents(agentDir, sessionKey, index);
    expect(recovered.filter(r => r.callId === callId)).toHaveLength(1); // no legacy+normalized duplicate
    expect(recovered[0].details).toMatchObject({ mode: 'workflow', runId }); // normalized wins
  });
});

describe('childSessionPointer + subagentChildTranscript', () => {
  let root: string;
  let tempBase: string;
  let agentDir: string;
  let savedEnv: string | undefined;
  beforeEach(() => {
    tempBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-transcript-test-'));
    root = path.join(tempBase, 'async-subagent-runs');
    fs.mkdirSync(root, { recursive: true });
    agentDir = path.join(tempBase, 'agent');
    fs.mkdirSync(agentDir, { recursive: true });
    savedEnv = process.env.PI_SUBAGENTS_TEMP_ROOT;
    process.env.PI_SUBAGENTS_TEMP_ROOT = tempBase; // subagentAsyncRoot() = tempBase/async-subagent-runs
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.PI_SUBAGENTS_TEMP_ROOT; else process.env.PI_SUBAGENTS_TEMP_ROOT = savedEnv;
    try { fs.rmSync(tempBase, { recursive: true, force: true }); } catch {}
  });

  const writeStatus = (runId: string, status: Record<string, any>) => {
    const dir = path.join(root, runId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(status));
  };

  // parent session lives in tempBase/parent/session.jsonl; child sessions nest under it
  const parentDir = () => path.join(tempBase, 'parent');
  const parentPath = () => path.join(parentDir(), 'parent.jsonl');

  function transcriptFixture(kind: 'workflow' | 'single') {
    const now = Date.now();
    const callId = 'call-t1';
    const wfRunId = 'dddddddd-1111-4111-8111-000000000001';
    const childRunId = 'eeeeeeee-2222-4222-8222-000000000002';
    const childSessionDir = path.join(parentDir(), 'child-1', 'run-0');
    fs.mkdirSync(childSessionDir, { recursive: true });
    const childSessionFile = path.join(childSessionDir, 'session.jsonl');
    const lines = [
      JSON.stringify({ type: 'session', id: 'child-1', cwd: '/x' }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: 'review the diff' } }),
      JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret chain of thought' }, { type: 'text', text: 'first finding' }] } }),
      JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 't1', name: 'read', arguments: { path: '/a'.repeat(5000) } }] } }),
      JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(9000) }, { type: 'image', data: 'AAAA' }] } }),
    ].join('\n') + '\n';
    fs.writeFileSync(childSessionFile, lines);
    let details: any;
    if (kind === 'workflow') {
      writeStatus(wfRunId, { runId: wfRunId, toolCallId: callId, sessionId: parentPath(), mode: 'workflow', state: 'completed', startedAt: now - 10000, lastUpdate: now - 500, workflowChildren: { version: 1, parentToolCallId: callId, workflowRunId: wfRunId, inventoryComplete: true, workflowState: 'completed', children: [{ childId: 'review', runId: childRunId, agent: 'code-reviewer', state: 'completed' }] } });
      writeStatus(childRunId, { runId: childRunId, toolCallId: 'ct1', sessionId: parentPath(), mode: 'single', state: 'complete', startedAt: now - 9000, lastUpdate: now - 400, parentWorkflowRunId: wfRunId, workflowKey: 'review', sessionFile: childSessionFile });
      details = { mode: 'workflow', runId: wfRunId, asyncId: wfRunId, asyncDir: path.join(root, wfRunId), results: [], workflowChildren: { version: 1, parentToolCallId: callId, workflowRunId: wfRunId, inventoryComplete: false, workflowState: 'completed', children: [] } };
    } else {
      writeStatus(childRunId, { runId: childRunId, toolCallId: callId, sessionId: parentPath(), mode: 'single', state: 'complete', startedAt: now - 9000, lastUpdate: now - 400, sessionFile: childSessionFile });
      details = { mode: 'single', runId: childRunId, asyncId: childRunId, asyncDir: path.join(root, childRunId), results: [] };
    }
    const toolCall = { type: 'message', id: 'm1', message: { role: 'assistant', content: [{ type: 'toolCall', id: callId, name: 'subagent', arguments: { agent: 'code-reviewer' } }] }, timestamp: new Date().toISOString() };
    const toolResult = { type: 'message', id: 'm2', message: { role: 'toolResult', toolCallId: callId, toolName: 'subagent', content: [], details } };
    const history = makeHistory(parentPath(), [toolCall, toolResult]);
    return { callId, childRunId, childSessionFile, history };
  }

  it('resolves a workflow child session file via the validated pointer chain', async () => {
    const { callId, childSessionFile, history } = transcriptFixture('workflow');
    const file = await childSessionPointer(history, [], callId, 'review', root);
    expect(file).toBe(childSessionFile);
    expect(await childSessionPointer(history, [], callId, 'wrong-key', root)).toBeUndefined();
    expect(await childSessionPointer(history, [], 'unknown-call', 'review', root)).toBeUndefined();
  });
  it('resolves a single-async child session file only for childId single', async () => {
    const { callId, childSessionFile, history } = transcriptFixture('single');
    expect(await childSessionPointer(history, [], callId, 'single', root)).toBe(childSessionFile);
    expect(await childSessionPointer(history, [], callId, 'other', root)).toBeUndefined();
  });
  it('subagentChildTranscript returns a bounded, sanitized tail', async () => {
    const { callId, history } = transcriptFixture('workflow');
    const index = { subagentHistory: () => history } as any;
    const res = await subagentChildTranscript(agentDir, 'a'.repeat(64), index, callId, 'review');
    expect('messages' in res).toBe(true);
    if (!('messages' in res)) return;
    // thinking payload dropped, long text capped, image replaced, tool args truncated
    const all = JSON.stringify(res.messages);
    expect(all).toContain('first finding');
    expect(all).toContain('子代理详情省略思考内容');
    expect(all).toContain('[image]');
    expect(all).not.toContain('secret chain of thought');
    expect(all.length).toBeLessThan(20000);
  });
  it('rejects a sessionFile outside the parent session directory', async () => {
    const { callId, childRunId, history } = transcriptFixture('workflow');
    // rewrite child status pointing outside
    writeStatus(childRunId, { runId: childRunId, toolCallId: 'ct1', sessionId: parentPath(), mode: 'single', state: 'complete', startedAt: Date.now() - 9000, lastUpdate: Date.now() - 400, parentWorkflowRunId: 'dddddddd-1111-4111-8111-000000000001', workflowKey: 'review', sessionFile: '/etc/hosts' });
    const index = { subagentHistory: () => history } as any;
    const res = await subagentChildTranscript(agentDir, 'a'.repeat(64), index, callId, 'review');
    expect(res).toEqual({ error: 'outside-sessions-root' });
  });
  it('reports no-snapshot when the async run directory is gone', async () => {
    const { callId, childRunId, history } = transcriptFixture('workflow');
    fs.rmSync(path.join(root, childRunId), { recursive: true, force: true });
    const index = { subagentHistory: () => history } as any;
    const res = await subagentChildTranscript(agentDir, 'a'.repeat(64), index, callId, 'review');
    expect(res).toEqual({ error: 'no-snapshot' });
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
