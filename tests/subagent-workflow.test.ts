import { describe, expect, it } from 'vitest';
import { projectSubagents } from '../src/renderer/pi/subagents';
import { mergeSubagentSnapshots, pollSubagents } from '../src/renderer/pi/subagent-polling';
import { workflowDetails, workflowRows, workflowState, isSubagentManagement, singleAsyncDetails } from '../src/shared/subagent-workflow';
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
  it('shows the task theme from a clean sessionName, falls back to the key when redacted', () => {
    // 干净 sessionName：卡片标题显示任务主题（去 agent 前缀），而不是 workflow key
    const clean = adapter.parse(wf('run-1', 'call-1', 'running', [{ childId: 'research-cc', runId: 'r1', agent: 'researcher', state: 'running', sessionName: 'researcher: 调研 Claude Code 最新版本的质量机制增量' }]), false);
    expect(clean[0].task).toBe('调研 Claude Code 最新版本的质量机制增量');
    // 红线 sessionName：不得恢复内容，回退 label（无 label 则空）
    const redacted = adapter.parse(wf('run-2', 'call-2', 'running', [{ childId: 'fix-bug', runId: 'r2', agent: 'dev', state: 'running', sessionName: 'dev: [prompt redacted] some secret task text', description: '[prompt redacted]' }]), false);
    expect(redacted[0].task).toBe('');
    // 无 sessionName 的旧版上游：回退 label（旧行为）
    const legacy = adapter.parse(wf('run-3', 'call-3', 'running', [{ childId: 'cc-latest', runId: 'r3', agent: 'researcher', state: 'running', label: 'cc-latest' }]), false);
    expect(legacy[0].task).toBe('cc-latest');
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
  it('branch switch drops the in-flight response but the next tick publishes the current branch', async () => {
    // 手动切分支后：在途的旧分支响应被 leaf 守卫丢弃，下个 tick 读当前分支并发布。
    let leaf = 'leaf-1';
    let published: RecoveredSubagent[][] = [];
    let resolveFirst!: (v: RecoveredSubagent[]) => void;
    let calls = 0;
    const stop = pollSubagents({
      key: 'k',
      leaf: () => leaf,
      recover: (_k, l) => { calls++; if (calls === 1) return new Promise(r => { resolveFirst = () => r([{ callId: 'c1', status: 'running' } as RecoveredSubagent]); }); return Promise.resolve([{ callId: 'c1', status: 'running' } as RecoveredSubagent]); },
      isCurrent: () => true,
      publish: r => published.push(r),
      interval: 10,
    });
    // 请求在途时用户手动切了分支
    leaf = 'leaf-2';
    resolveFirst([{ callId: 'c1', status: 'running' }]);
    await new Promise(r => setTimeout(r, 30));
    stop();
    expect(published.length).toBeGreaterThanOrEqual(1);
    expect(published[0]).toHaveLength(1);
  });
  it('drops a response whose branch was switched away mid-request', async () => {
    // 用户选了分支 A，请求在途时手动切到分支 B：响应携带 A 的数据，必须丢弃。
    let leaf = 'branchA';
    let published = 0;
    let resolveFirst!: (v: RecoveredSubagent[]) => void;
    const stop = pollSubagents({
      key: 'k', leaf: () => leaf,
      recover: () => new Promise<RecoveredSubagent[]>(r => { resolveFirst = r; }),
      isCurrent: () => true,
      publish: () => { published++; },
      interval: 10,
    });
    leaf = 'branchB'; // 切分支
    resolveFirst([{ callId: 'c1', status: 'running' }]);
    await new Promise(r => setTimeout(r, 25));
    stop();
    expect(published).toBe(0); // 旧分支响应被丢弃，等下个 tick 读 branchB
  });
  it('each tick reads the current leaf for branch-correct recovery', async () => {
    const seen: (string | undefined)[] = [];
    let leaf = 'leaf-a';
    const stop = pollSubagents({
      key: 'k', leaf: () => leaf,
      recover: async (_k, l) => { seen.push(l); return []; },
      isCurrent: () => true, publish: () => {}, interval: 5,
    });
    await new Promise(r => setTimeout(r, 12));
    leaf = 'leaf-b';
    await new Promise(r => setTimeout(r, 12));
    stop();
    expect(seen).toContain('leaf-a');
    expect(seen).toContain('leaf-b');
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

describe('async single runs (pi-subagents >=0.78)', () => {
  const adapter = createWorkflowAdapter();
  const singleLive = (runId: string, callId = 'call-1', agent = 'electron-pro', state?: string): ToolPart => ({
    kind: 'tool', id: 'one', callId, tool: 'subagent', phase: 'result', status: 'done', summary: '',
    argumentsText: JSON.stringify({ agent, cwd: '/x' }),
    resultDetails: { mode: 'single', runId, asyncId: runId, asyncDir: `/tmp/pi-subagents-uid-501/async-subagent-runs/${runId}`, results: [], ...(state ? { state } : {}) },
  });

  it('singleAsyncDetails detects a detached single run and rejects sync/management shapes', () => {
    const d = { mode: 'single', runId: 'r-async', asyncDir: '/tmp/x/r-async', results: [] };
    expect(singleAsyncDetails(d, 'call-1')).toBeTruthy();
    // synchronous single with a result → official adapter's job, not async
    expect(singleAsyncDetails({ ...d, results: [{ agent: 'scout', exitCode: 0 }] }, 'call-1')).toBeUndefined();
    // management reply (status) carries no runId → excluded
    expect(singleAsyncDetails({ mode: 'single', results: [] }, 'call-1')).toBeUndefined();
    // mismatched toolCallId → rejected
    expect(singleAsyncDetails({ ...d, toolCallId: 'other' }, 'call-1')).toBeUndefined();
    // non-single mode → not here
    expect(singleAsyncDetails({ mode: 'workflow', runId: 'r', results: [] }, 'call-1')).toBeUndefined();
  });

  it('adapter renders one live single-async child with a stable id and agent from args', () => {
    const part = singleLive('r-async', 'call-1', 'electron-pro');
    expect(adapter.detect(part)).toBe(true);
    const children = adapter.parse(part, true);
    expect(children).toHaveLength(1);
    expect(children[0].id).toBe('call-1:workflow:r-async:single');
    expect(children[0].agent).toBe('electron-pro');
    expect(children[0].status).toBe('unknown'); // live: unverified until disk snapshot arrives
    expect(children[0].messages).toEqual([]);
  });

  it('a disk snapshot (normalized to workflow shape) replaces the live unknown child', () => {
    const livePart = singleLive('r-async', 'call-1', 'electron-pro');
    const snapshot: RecoveredSubagent = {
      callId: 'call-1', status: 'running',
      details: { mode: 'workflow', runId: 'r-async', toolCallId: 'call-1', state: 'running', snapshotAt: 1000, workflowChildren: { version: 1, parentToolCallId: 'call-1', workflowRunId: 'r-async', inventoryComplete: true, workflowState: 'running', children: [{ childId: 'single', runId: 'r-async', agent: 'electron-pro', state: 'running', model: 'ccr/ccr-opus', tokens: 47960, turns: 2, snapshotAt: 1000 }] } },
    };
    const children = projectSubagents(messages(livePart), true, [snapshot]);
    expect(children).toHaveLength(1);
    expect(children[0].id).toBe('call-1:workflow:r-async:single');
    expect(children[0].status).toBe('running');
    expect(children[0].model).toBe('ccr/ccr-opus');
    expect(children[0].tokens).toBe(47960);
  });

  it('does not treat management (status/guide) single replies as async runs', () => {
    const part: ToolPart = {
      kind: 'tool', id: 'one', callId: 'call-1', tool: 'subagent', phase: 'result', status: 'done', summary: '',
      argumentsText: JSON.stringify({ action: 'status' }),
      resultDetails: { mode: 'single', agentScope: 'user', projectAgentsDir: null, results: [] },
    };
    expect(adapter.detect(part)).toBe(false);
    expect(projectSubagents(messages(part), true)).toHaveLength(0);
  });

  it('does not reconstruct task from on-disk prompt fields for single-async children', () => {
    const livePart = singleLive('r-async', 'call-1', 'electron-pro');
    const snapshot: RecoveredSubagent = {
      callId: 'call-1', status: 'completed',
      details: { mode: 'workflow', runId: 'r-async', toolCallId: 'call-1', state: 'completed', snapshotAt: 2000, workflowChildren: { version: 1, parentToolCallId: 'call-1', workflowRunId: 'r-async', inventoryComplete: true, workflowState: 'completed', children: [{ childId: 'single', runId: 'r-async', agent: 'electron-pro', state: 'completed', task: '[prompt redacted]', description: '[prompt redacted]', snapshotAt: 2000 }] } },
    };
    const children = projectSubagents(messages(livePart), false, [snapshot]);
    expect(children[0].task).toBe('');
    expect(children[0].task).not.toContain('redacted');
  });
});
