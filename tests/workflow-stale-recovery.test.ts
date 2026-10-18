import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recoverSubagents } from '../src/main/pi/official-subagent';
import { subagentAsyncRoot } from '../src/main/pi/subagent-snapshots';
import { workflowSnapshots } from '../src/main/pi/subagent-snapshots';
import type { SessionIndex } from '../src/main/pi/session-index';
import type { PiHistory } from '../src/shared/pi';

// 假活工作流：tool result 里冻结的 workflowChildren.workflowState='running'，但 asyncDir
// 的 status.json 早已是终态。尾窗（MAX_CALLS=32）外的老卡片如果不 pinned，永远拿不到校正。
// 用户 2026-10-18 实测：238 对调用的会话里 16 个假活卡片「等待工作流报告子任务 · 运行中」。

const SESSION = '/sessions/parent.jsonl';

/** 造一个「已结束但 tool result 里冻结在 running」的工作流：asyncDir/status.json 是
 *  终态（completed），而 resultDetails.workflowChildren.workflowState 是 'running'。 */
function makeWorkflow(root: string, runId: string, toolCallId: string, startedAt: number) {
  const asyncDir = path.join(root, runId);
  fs.mkdirSync(asyncDir, { recursive: true });
  fs.writeFileSync(path.join(asyncDir, 'status.json'), JSON.stringify({
    mode: 'workflow', runId, toolCallId, sessionId: SESSION,
    startedAt, lastUpdate: Date.now() - 60_000,
    state: 'completed', workflowChildren: { version: 1, parentToolCallId: toolCallId, workflowRunId: runId, inventoryComplete: true, workflowState: 'completed', children: [] },
  }));
  return {
    mode: 'workflow', runId, toolCallId, asyncDir, results: [],
    workflowChildren: { version: 1, parentToolCallId: toolCallId, workflowRunId: runId, inventoryComplete: false, workflowState: 'running', children: [] },
  };
}

/** pairs 对 subagent 调用（call/result 成对）。全部造得比尾窗（32）多，前 pairs-2 对
 *  落在窗外。timestamp 与 status.startedAt 满足 validTime（>= toolCall 时间 - 60s）。 */
function makeHistory(pairs: number, root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-stale-')), runPrefix = 'run-'): { root: string; history: PiHistory } {
  const branch: any[] = [];
  const entries: any[] = [];
  const base = Date.now() - pairs * 1000;
  for (let i = 0; i < pairs; i += 1) {
    const runId = `${runPrefix}${i}`, callId = `call-${i}`;
    const at = base + i * 1000;
    const details = makeWorkflow(root, runId, callId, at - 30_000);
    branch.push({ type: 'message', id: `a${i}`, timestamp: new Date(at).toISOString(), message: { role: 'assistant', content: [{ type: 'toolCall', id: callId, name: 'subagent', arguments: { task: '跑一个工作流' } }] } });
    branch.push({ type: 'message', id: `r${i}`, timestamp: new Date(at + 1).toISOString(), message: { role: 'toolResult', toolCallId: callId, toolName: 'subagent', details } });
    entries.push(...branch.slice(-2));
  }
  return { root, history: { session: { path: SESSION, key: 'k', size: 1, updatedAt: Date.now() } as any, entries, branch, leaves: [], leafId: null, syncedAt: Date.now() } };
}

describe('stale workflow recovery past the MAX_CALLS window', () => {
  it('tail window stays bounded at MAX_CALLS and corrects what it covers', async () => {
    const { history, root } = makeHistory(40);
    const out = await workflowSnapshots(history, [], root, Date.now());
    expect(out.length).toBe(32); // 尾窗有界（列表渲染成本）
    // 窗外的老卡片不在结果里（不 pinned 就没有）——这正是 ghost running 的来源
    expect(out.some(s => s.callId === 'call-0')).toBe(false);
  });

  it('pinned old workflow gets its terminal state from asyncDir/status.json', async () => {
    const { history, root } = makeHistory(40);
    // 不 pinned：尾窗外的 call-0 不在结果里
    const plain = await workflowSnapshots(history, [], root, Date.now());
    expect(plain.some(s => s.callId === 'call-0')).toBe(false);
    // pinned：穿透尾窗，读到 status.json 的 completed（覆盖冻结的 running）
    const pinned = await workflowSnapshots(history, [], root, Date.now(), ['call-0']);
    const row = pinned.find(s => s.callId === 'call-0');
    expect(row).toBeDefined();
    expect(row!.status).toBe('completed');
    expect((row!.details as any).workflowChildren.workflowState).toBe('completed');
  });

  it('recoverSubagents forwards pinned so the renderer stops showing ghost running rows', async () => {
    // recoverSubagents 内部用默认 root（subagentAsyncRoot()）：fixture 的 asyncDir 必须
    // 精确等于 <系统root>/<runId>，否则指针校验（containment）拒绝。runId 加测试专属前缀。
    const root = subagentAsyncRoot();
    fs.mkdirSync(root, { recursive: true });
    const { history } = makeHistory(40, root, 'stale-rec-');
    const index = { subagentHistory: () => history } as unknown as SessionIndex;
    const out = await recoverSubagents('/agent', 'a'.repeat(64), index, undefined, ['call-0', 'call-1']);
    // 窗外的两个老工作流经 pinned 穿透 + status.json 校正为终态
    expect(out.some(s => s.callId === 'call-0' && s.status === 'completed')).toBe(true);
    expect(out.some(s => s.callId === 'call-1' && s.status === 'completed')).toBe(true);
    // pinned 不重复注入同一 callId
    expect(out.filter(s => s.callId === 'call-0').length).toBe(1);
  });
});
