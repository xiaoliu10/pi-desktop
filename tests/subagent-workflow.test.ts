import { describe, expect, it } from 'vitest';
import { projectSubagents } from '../src/renderer/pi/subagents';
import { mergeSubagentSnapshots, pollSubagents } from '../src/renderer/pi/subagent-polling';
import { workflowDetails, workflowRows, workflowState, isSubagentManagement } from '../src/shared/subagent-workflow';
import { createWorkflowAdapter } from '../src/renderer/pi/subagent-registry';
import type { ChatMessage, ToolPart } from '../src/renderer/replica/contracts';
import type { RecoveredSubagent } from '../src/renderer/pi/subagents';

const wf = (runId: string, callId = 'call-1', state = 'running', children: any[] = []): ToolPart => ({
  kind: 'tool', id: 'one', callId, tool: 'subagent', phase: 'progress', status: 'running', summary: '',
  resultDetails: { mode: 'workflow', runId, toolCallId: callId, asyncId: runId, asyncDir: `/tmp/pi-subagents-uid-501/async-subagent-runs/${runId}`, results: [], workflowChildren: { version: 1, parentToolCallId: callId, workflowRunId: runId, inventoryComplete: false, workflowState: state, children } },
});
const messages = (...parts: ToolPart[]): ChatMessage[] => [{ id: 'm', role: 'assistant', parts }];

describe('shared/subagent-workflow', () => {
  it('maps plugin states to a stable, honest set', () => {
    expect(workflowState('running')).toBe('running');
    expect(workflowState('pending')).toBe('queued');
    expect(workflowState('queued')).toBe('queued');
    expect(workflowState('completed')).toBe('completed');
    expect(workflowState('failed')).toBe('failed');
    expect(workflowState('rejected')).toBe('failed');
    expect(workflowState('paused')).toBe('interrupted');
    expect(workflowState('stopped')).toBe('interrupted');
    expect(workflowState('aborted')).toBe('interrupted');
    expect(workflowState('something-else')).toBe('unknown');
    expect(workflowState(undefined)).toBe('unknown');
  });
  it('isSubagentManagement rejects status/guide/list actions', () => {
    expect(isSubagentManagement(JSON.stringify({ action: 'status' }))).toBe(true);
    expect(isSubagentManagement(JSON.stringify({ action: 'guide' }))).toBe(true);
    expect(isSubagentManagement(JSON.stringify({ agent: 'scout', task: 'hi' }))).toBe(false);
    expect(isSubagentManagement('not json')).toBe(false);
  });
  it('workflowDetails validates structure and identity', () => {
    const d = { mode: 'workflow', runId: 'run-1', toolCallId: 'call-1', workflowChildren: { version: 1, parentToolCallId: 'call-1', workflowRunId: 'run-1', inventoryComplete: false, workflowState: 'running', children: [] } };
    expect(workflowDetails(d, 'call-1')).toBeTruthy();
    expect(workflowDetails({ ...d, toolCallId: 'other' }, 'call-1')).toBeUndefined(); // mismatched toolCallId
    expect(workflowDetails({ ...d, mode: 'single' }, 'call-1')).toBeUndefined(); // not workflow
    expect(workflowDetails({ ...d, runId: 'bad run' }, 'call-1')).toBeUndefined(); // invalid id
    expect(workflowDetails({ ...d, workflowChildren: { ...d.workflowChildren, parentToolCallId: 'other' } }, 'call-1')).toBeUndefined();
  });
  it('workflowRows dedupes by stable key across inventory + steps', () => {
    const d = {
      mode: 'workflow', runId: 'run-1', toolCallId: 'call-1',
      steps: [{ workflowKey: 'fix-bug', runId: 'child-1', agent: 'dev', status: 'running' }],
      workflowChildren: { version: 1, parentToolCallId: 'call-1', workflowRunId: 'run-1', inventoryComplete: false, workflowState: 'running', children: [{ childId: 'fix-bug', state: 'running', runId: 'child-1', agent: 'dev' }] },
    };
    const rows = workflowRows(d as any);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ childId: 'fix-bug', runId: 'child-1', agent: 'dev' });
  });
});

describe('workflow adapter projection', () => {
  const adapter = createWorkflowAdapter();
  it('detects workflow mode and ignores management replies', () => {
    expect(adapter.detect(wf('run-1'))).toBe(true);
    const mgmt = wf('run-1');
    (mgmt as any).argumentsText = JSON.stringify({ action: 'status' });
    expect(adapter.detect(mgmt)).toBe(false);
  });
  it('renders an honest waiting card when inventory is empty', () => {
    const children = adapter.parse(wf('run-1'), false);
    expect(children).toHaveLength(1);
    expect(children[0].status).toBe('running');
    expect(children[0].agent).toBe('Workflow');
    expect(children[0].task).toContain('等待');
    expect(children[0].messages).toEqual([]);
  });
  it('projects discovered children with stable keys', () => {
    const part = wf('run-1', 'call-1', 'running', [{ childId: 'fix-bug', runId: 'child-1', agent: 'dev', state: 'running' }, { childId: 'add-tests', runId: 'child-2', agent: 'qa', state: 'queued' }]);
    const children = adapter.parse(part, false);
    expect(children.map(c => c.id)).toEqual(['call-1:workflow:run-1:fix-bug', 'call-1:workflow:run-1:add-tests']);
    expect(children.map(c => c.status)).toEqual(['running', 'queued']);
    expect(children.map(c => c.agent)).toEqual(['dev', 'qa']);
  });
  it('does not infer completion from parent idle or tool result phase', () => {
    const part = wf('run-1', 'call-1', 'running', [{ childId: 'fix-bug', runId: 'child-1', agent: 'dev', state: 'running' }]);
    part.phase = 'result';
    part.status = 'done';
    const children = adapter.parse(part, false); // parentRunning=false, phase=result
    expect(children[0].status).toBe('running'); // still running, not completed/interrupted
  });
  it('stable keys survive reordering and append', () => {
    const part1 = wf('run-1', 'call-1', 'running', [{ childId: 'a', runId: 'ca', agent: 'dev', state: 'running' }, { childId: 'b', runId: 'cb', agent: 'qa', state: 'queued' }]);
    const part2 = wf('run-1', 'call-1', 'running', [{ childId: 'b', runId: 'cb', agent: 'qa', state: 'running' }, { childId: 'a', runId: 'ca', agent: 'dev', state: 'completed' }, { childId: 'c', runId: 'cc', agent: 'ops', state: 'queued' }]);
    const c1 = adapter.parse(part1, false).map(c => ({ id: c.id, status: c.status }));
    const c2 = adapter.parse(part2, false).map(c => ({ id: c.id, status: c.status }));
    // a and b keep their same stable ids; c is appended
    expect(c2.find(c => c.id.includes(':a'))?.status).toBe('completed');
    expect(c2.find(c => c.id.includes(':b'))?.status).toBe('running');
    expect(c2.find(c => c.id.includes(':c'))?.status).toBe('queued');
    expect(c1[0].id).toBe(c2.find(c => c.id.includes(':a'))!.id);
  });
  it('marks terminal children correctly', () => {
    const part = wf('run-1', 'call-1', 'completed', [{ childId: 'ok', runId: 'c1', agent: 'dev', state: 'completed' }, { childId: 'err', runId: 'c2', agent: 'dev', state: 'failed' }, { childId: 'stop', runId: 'c3', agent: 'dev', state: 'stopped' }]);
    const children = adapter.parse(part, false);
    expect(children.map(c => c.status)).toEqual(['completed', 'failed', 'interrupted']);
  });
  it('does not reverse-decrypt tasks from sessionName or redacted prompt fields', () => {
    const part = wf('run-1', 'call-1', 'running', [{ childId: 'fix-bug', runId: 'c1', agent: 'dev', state: 'running', sessionName: 'dev: [prompt redacted] some secret task text', description: '[prompt redacted]' }]);
    const children = adapter.parse(part, false);
    expect(children[0].task).toBe(''); // no label field → empty, not reconstructed
    expect(children[0].task).not.toContain('secret');
  });
});

describe('projectSubagents with workflow details', () => {
  it('renders running child from a live workflow part', () => {
    const children = projectSubagents(messages(wf('run-1', 'call-1', 'running', [{ childId: 'fix-bug', runId: 'child-1', agent: 'dev', state: 'running' }])), true);
    expect(children).toHaveLength(1);
    expect(children[0].status).toBe('running');
  });
  it('renders honest waiting card when no children discovered', () => {
    const children = projectSubagents(messages(wf('run-1', 'call-1', 'running', [])), true);
    expect(children).toHaveLength(1);
    expect(children[0].agent).toBe('Workflow');
    expect(children[0].status).toBe('running');
  });
  it('parent idle does not interrupt async children', () => {
    const children = projectSubagents(messages(wf('run-1', 'call-1', 'running', [{ childId: 'fix-bug', runId: 'child-1', agent: 'dev', state: 'running' }])), false);
    expect(children[0].status).toBe('running'); // not interrupted
  });
  it('merges verified async snapshots without duplicating callId', () => {
    const livePart = wf('run-1', 'call-1', 'running', [{ childId: 'fix-bug', runId: 'child-1', agent: 'dev', state: 'running' }]);
    const snapshot: RecoveredSubagent = { callId: 'call-1', status: 'running', details: { mode: 'workflow', runId: 'run-1', toolCallId: 'call-1', state: 'running', snapshotAt: 2000, workflowChildren: { version: 1, parentToolCallId: 'call-1', workflowRunId: 'run-1', inventoryComplete: false, workflowState: 'running', children: [{ childId: 'fix-bug', runId: 'child-1', agent: 'dev', state: 'running', snapshotAt: 2000 }] } } };
    const children = projectSubagents(messages(livePart), true, [snapshot]);
    expect(children).toHaveLength(1); // deduped, not 2
    expect(children[0].id).toBe('call-1:workflow:run-1:fix-bug');
  });
  it('uses newer snapshot when live is stale', () => {
    const livePart = wf('run-1', 'call-1', 'running', [{ childId: 'fix-bug', runId: 'child-1', agent: 'dev', state: 'running' }]);
    (livePart.resultDetails as any).snapshotAt = 1000;
    const snapshot: RecoveredSubagent = { callId: 'call-1', status: 'completed', details: { mode: 'workflow', runId: 'run-1', toolCallId: 'call-1', state: 'completed', snapshotAt: 3000, workflowChildren: { version: 1, parentToolCallId: 'call-1', workflowRunId: 'run-1', inventoryComplete: true, workflowState: 'completed', children: [{ childId: 'fix-bug', runId: 'child-1', agent: 'dev', state: 'completed', snapshotAt: 3000 }] } } };
    const children = projectSubagents(messages(livePart), false, [snapshot]);
    expect(children[0].status).toBe('completed');
  });
  it('does not let stale snapshot override newer live', () => {
    const livePart = wf('run-1', 'call-1', 'running', [{ childId: 'fix-bug', runId: 'child-1', agent: 'dev', state: 'running' }]);
    (livePart.resultDetails as any).snapshotAt = 3000;
    const snapshot: RecoveredSubagent = { callId: 'call-1', status: 'queued', details: { mode: 'workflow', runId: 'run-1', toolCallId: 'call-1', state: 'queued', snapshotAt: 1000, workflowChildren: { version: 1, parentToolCallId: 'call-1', workflowRunId: 'run-1', inventoryComplete: false, workflowState: 'queued', children: [{ childId: 'fix-bug', runId: 'child-1', agent: 'dev', state: 'queued', snapshotAt: 1000 }] } } };
    const children = projectSubagents(messages(livePart), true, [snapshot]);
    expect(children[0].status).toBe('running'); // live wins
  });
  it('renders recovered-only workflow snapshot when session file has no live part', () => {
    const snapshot: RecoveredSubagent = { callId: 'call-9', status: 'running', details: { mode: 'workflow', runId: 'run-9', toolCallId: 'call-9', state: 'running', workflowChildren: { version: 1, parentToolCallId: 'call-9', workflowRunId: 'run-9', inventoryComplete: false, workflowState: 'running', children: [{ childId: 'fix-bug', runId: 'child-9', agent: 'dev', state: 'running' }] } } };
    const children = projectSubagents(messages(), false, [snapshot]);
    expect(children).toHaveLength(1);
    expect(children[0].callId).toBe('call-9');
    expect(children[0].status).toBe('running');
    expect(children[0].recovered).toBe(true);
  });
  it('ignores management action results (status/guide/list) — no false children', () => {
    const mgmtPart: ToolPart = { ...wf('run-1', 'call-mgmt'), argumentsText: JSON.stringify({ action: 'status' }), resultDetails: { mode: 'workflow', runId: 'run-1', results: [{ agent: 'dev' }] } };
    expect(projectSubagents(messages(mgmtPart), false)).toEqual([]);
  });
});

describe('mergeSubagentSnapshots (anti-stale-override)', () => {
  it('does not roll back a newer child with an older sibling snapshot', () => {
    const prev: RecoveredSubagent[] = [{ callId: 'c1', status: 'running', details: { mode: 'workflow', runId: 'r1', toolCallId: 'c1', state: 'running', snapshotAt: 5000, workflowChildren: { version: 1, parentToolCallId: 'c1', workflowRunId: 'r1', inventoryComplete: false, workflowState: 'running', children: [{ childId: 'a', runId: 'ca', state: 'running', snapshotAt: 5000 }] } } }];
    const incoming: RecoveredSubagent[] = [{ callId: 'c1', status: 'running', details: { mode: 'workflow', runId: 'r1', toolCallId: 'c1', state: 'running', snapshotAt: 3000, workflowChildren: { version: 1, parentToolCallId: 'c1', workflowRunId: 'r1', inventoryComplete: false, workflowState: 'running', children: [{ childId: 'a', runId: 'ca', state: 'running', snapshotAt: 3000 }] } } }];
    const merged = mergeSubagentSnapshots(prev, incoming);
    const w = workflowDetails(merged[0].details, 'c1')!;
    expect(w.snapshotAt).toBe(5000); // newer retained
    expect(workflowRows(w)[0].snapshotAt).toBe(5000);
  });
  it('does not drop a child missing from a later snapshot', () => {
    const prev: RecoveredSubagent[] = [{ callId: 'c1', status: 'running', details: { mode: 'workflow', runId: 'r1', toolCallId: 'c1', state: 'running', snapshotAt: 5000, workflowChildren: { version: 1, parentToolCallId: 'c1', workflowRunId: 'r1', inventoryComplete: true, workflowState: 'running', children: [{ childId: 'a', runId: 'ca', state: 'running', snapshotAt: 5000 }, { childId: 'b', runId: 'cb', state: 'running', snapshotAt: 5000 }] } } }];
    const incoming: RecoveredSubagent[] = [{ callId: 'c1', status: 'running', details: { mode: 'workflow', runId: 'r1', toolCallId: 'c1', state: 'running', snapshotAt: 6000, workflowChildren: { version: 1, parentToolCallId: 'c1', workflowRunId: 'r1', inventoryComplete: true, workflowState: 'running', children: [{ childId: 'a', runId: 'ca', state: 'completed', snapshotAt: 6000 }] } } }];
    const merged = mergeSubagentSnapshots(prev, incoming);
    const rows = workflowRows(workflowDetails(merged[0].details, 'c1')!);
    expect(rows.map(r => r.childId).sort()).toEqual(['a', 'b']);
    expect(rows.find(r => r.childId === 'b')?.state).toBe('unknown'); // stale → unknown, not silently dropped
  });
});

describe('pollSubagents lifecycle', () => {
  it('publishes records and stops on dispose', async () => {
    let published: RecoveredSubagent[][] = [];
    const stop = pollSubagents({
      key: 'k', recover: async () => [{ callId: 'c1', status: 'running' }],
      isCurrent: () => true, publish: r => published.push(r), interval: 10,
    });
    await new Promise(r => setTimeout(r, 35));
    stop();
    expect(published.length).toBeGreaterThanOrEqual(1);
    const countBefore = published.length;
    await new Promise(r => setTimeout(r, 30));
    expect(published.length).toBe(countBefore); // no more after stop
  });
  it('A→B late return does not write A to B', async () => {
    let resolveA!: (v: RecoveredSubagent[]) => void;
    const stop = pollSubagents({
      key: 'k', recover: () => new Promise(r => { resolveA = r; }),
      isCurrent: () => false, // switched away
      publish: () => { throw new Error('should not publish stale'); }, interval: 10,
    });
    resolveA([{ callId: 'c1', status: 'running' }]);
    await new Promise(r => setTimeout(r, 20));
    stop();
  });
  it('parent idle (not running) still polls and publishes', async () => {
    let published = 0;
    const stop = pollSubagents({
      key: 'k', recover: async () => [{ callId: 'c1', status: 'running' }],
      isCurrent: () => true, publish: () => { published++; }, interval: 10,
    });
    await new Promise(r => setTimeout(r, 35));
    stop();
    expect(published).toBeGreaterThanOrEqual(1);
  });
});

describe('legacy regression (single/parallel/chain)', () => {
  const result = (agent = 'scout', exitCode = 0) => ({ agent, agentSource: 'user', task: 'Inspect', exitCode, messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Found it' }] }], usage: { input: 12, output: 3, turns: 1, cost: .01 } });
  const part = (phase: ToolPart['phase'], results: unknown[], mode = 'single'): ToolPart => ({ kind: 'tool', id: 'one', callId: 'call-1', tool: 'subagent', phase, status: phase === 'result' ? 'done' : 'running', summary: '', resultDetails: { mode, agentScope: 'both', projectAgentsDir: null, results } });
  it('single mode still works', () => {
    expect(projectSubagents(messages(part('progress', [result()])), true)[0].status).toBe('running');
    expect(projectSubagents(messages(part('result', [result()])), false)[0].status).toBe('completed');
  });
  it('parallel mode stable siblings', () => {
    const p = part('result', [result('scout'), result('scout', 1)], 'parallel'); p.status = 'error';
    const out = projectSubagents(messages(p), false);
    expect(out.map(c => c.id)).toEqual(['call-1:0', 'call-1:1']);
    expect(out.map(c => c.status)).toEqual(['completed', 'failed']);
  });
  it('does not mistake workflow details for single/parallel/chain', () => {
    const p = wf('run-1'); // workflow mode
    expect(projectSubagents(messages(p), false)[0].mode).toBe('workflow');
    expect(projectSubagents(messages(p), false)[0].status).not.toBe('completed');
  });
});

describe('missing/corrupt/unsafe snapshots', () => {
  it('corrupt workflowChildren is rejected by workflowDetails', () => {
    expect(workflowDetails({ mode: 'workflow', runId: 'r1', toolCallId: 'c1', workflowChildren: { version: 2, parentToolCallId: 'c1', workflowRunId: 'r1', inventoryComplete: false, workflowState: 'running', children: [] } }, 'c1')).toBeUndefined();
    expect(workflowDetails({ mode: 'workflow', runId: 'r1', toolCallId: 'c1', workflowChildren: { version: 1, parentToolCallId: 'other', workflowRunId: 'r1', inventoryComplete: false, workflowState: 'running', children: [] } }, 'c1')).toBeUndefined();
  });
  it('asyncDir outside root would be rejected by snapshot reader (identity check)', () => {
    // The adapter itself does not read files; it trusts details from IPC.
    // But workflowDetails rejects mismatched asyncDir in recoverSubagents.
    const d = { mode: 'workflow', runId: 'r1', toolCallId: 'c1', asyncDir: '/etc/passwd', asyncId: 'r1', workflowChildren: { version: 1, parentToolCallId: 'c1', workflowRunId: 'r1', inventoryComplete: false, workflowState: 'running', children: [] } };
    // workflowDetails itself accepts (it doesn't check asyncDir), but recoverSubagents validates
    expect(workflowDetails(d, 'c1')).toBeTruthy(); // structure valid
    // The asyncDir validation happens in the main process, not the shared helper.
  });
  it('renders unknown state for missing child runId', () => {
    const part = wf('run-1', 'call-1', 'running', [{ childId: 'no-run', agent: 'dev', state: 'running' }]); // no runId
    const children = projectSubagents(messages(part), true);
    expect(children[0].status).toBe('unknown'); // queued→unknown without runId (can't verify)
  });
});
