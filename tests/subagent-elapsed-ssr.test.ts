import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { recoverSubagents, subagentChildTranscript } from '../src/main/pi/official-subagent';
import { historyToMessages, usePiStore } from '../src/renderer/pi/adapter';
import { projectSubagents, type RecoveredSubagent, type SubagentChild } from '../src/renderer/pi/subagents';
import { Transcript } from '../src/renderer/pi/SubagentPanel';

/**
 * PR #149 独立审查三项缺陷的红绿回归（真实生产链，非理想化 record）：
 * 真实 recoverSubagents（主进程读沙箱里的 status.json，身份/时间校验）
 * → projectSubagents（渲染层投影）→ Transcript/TurnArticle React SSR，
 * 断言计时 DOM（pi-execution__elapsed）真实出现且数值正确，而不是只断言字段。
 * - 149-1：普通带指针 async single 的 record 必须透传真实 startedAt；
 * - 149-2：orphan 顶层状态口径统一（终态不再恒 unknown），completed/failed 都有真实用时；
 * - 149-3：workflow 每个 child 只用自己的已验证时钟，绝不拿父 workflow 时间兜底；
 * - EMPTY：零 assistant 消息不声称已恢复计时（诚实不显示）。
 */

const KEY = 'a'.repeat(64);

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) { try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* best effort */ } }
});

function mkRoot(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pr149-elapsed-')));
  roots.push(root);
  // 主进程 async 目录锚点指到本测试自己的沙箱（绝对路径），不碰用户环境。
  process.env.PI_SUBAGENTS_TEMP_ROOT = root;
  return root;
}

interface Env { root: string; asyncRoot: string; sessionFile: string }

function mkEnv(): Env {
  const root = mkRoot();
  const asyncRoot = path.join(root, 'async-subagent-runs');
  fs.mkdirSync(asyncRoot, { recursive: true });
  const sessionFile = path.join(root, 'parent.jsonl');
  fs.writeFileSync(sessionFile, '');
  return { root, asyncRoot, sessionFile };
}

function writeRun(env: Env, runId: string, status: Record<string, unknown>): void {
  fs.mkdirSync(path.join(env.asyncRoot, runId), { recursive: true });
  fs.writeFileSync(path.join(env.asyncRoot, runId, 'status.json'), JSON.stringify(status));
}

/** 普通带指针 async single：父历史 toolCall(带时间) + toolResult(async single 指针)。 */
function singlePointerEntries(env: Env, callId: string, runId: string, now: number): unknown[] {
  return [
    { id: 'a', type: 'message', timestamp: new Date(now - 10000).toISOString(), message: { role: 'assistant', content: [{ type: 'toolCall', id: callId, name: 'subagent', arguments: { agent: 'reviewer' } }] } },
    { id: 'b', type: 'message', message: { role: 'toolResult', toolCallId: callId, toolName: 'subagent', content: [], details: { mode: 'single', runId, asyncDir: path.join(env.asyncRoot, runId), agent: 'reviewer', results: [] } } },
  ];
}

const pointerHistory = (env: Env, entries: unknown[]) => ({
  session: { key: KEY, path: env.sessionFile, cwd: env.root, owned: true },
  entries, branch: entries, leaves: [], leafId: null,
});
const emptyHistory = (env: Env) => pointerHistory(env, []);

/** 详见时长文本：SSR 下 running 用渲染时刻时钟，complete 用 endedAt-startedAt（确定性）。 */
const elapsedText = (html: string): string | undefined => html.match(/pi-execution__elapsed[^>]*>([^<]+)</)?.[1];
const renderChild = (child: SubagentChild, messages: SubagentChild['messages']) =>
  renderToStaticMarkup(React.createElement(Transcript, { messages, turnKey: child.id, live: ['running', 'queued'].includes(child.status), startedAt: child.startedAt, endedAt: child.endedAt } as never));

it('149-1 普通指针 async single：running 显示真实已工作、complete 显示真实用时（DOM）', async () => {
  const zh = usePiStore.getState().lang !== 'en';
  const now = Date.now();
  const env = mkEnv();
  const entries = singlePointerEntries(env, 'call-single-1', 'run-single-1', now);
  const index = { subagentHistory: () => pointerHistory(env, entries) };
  // 真实子会话文件（消息带时间），主进程脱敏后时间被剥掉——计时只能来自快照。
  const childFile = path.join(env.root, 'child-single-1.jsonl');
  const raw = [
    { role: 'user', timestamp: now - 9000, content: [{ type: 'text', text: 'task' }] },
    { role: 'assistant', timestamp: now - 3000, content: [{ type: 'text', text: 'done' }] },
  ];
  fs.writeFileSync(childFile, raw.map((m, i) => JSON.stringify({ type: 'message', id: String(i), timestamp: new Date(m.timestamp).toISOString(), message: m })).join('\n') + '\n');
  const status = (state: string) => ({ mode: 'single', runId: 'run-single-1', sessionId: env.sessionFile, toolCallId: 'call-single-1', state, startedAt: now - 9000, lastUpdate: now - 2000, steps: [{ agent: 'reviewer', sessionFile: childFile }] });

  writeRun(env, 'run-single-1', status('running'));
  let recs = await recoverSubagents(env.root, KEY, index as never) as RecoveredSubagent[];
  expect(recs[0]!.startedAt).toBe(now - 9000); // 生产者透传真实起点
  const fetched = await subagentChildTranscript(env.root, KEY, index as never, 'call-single-1', 'single');
  if ('error' in fetched) throw new Error(`subagentChildTranscript failed: ${fetched.error}`);
  const msgs = fetched.messages;
  expect(msgs.length).toBeGreaterThan(0);
  expect(msgs.some(m => 'timestamp' in m)).toBe(false); // 脱敏消息无时间 → 计时必须靠快照

  let child = projectSubagents(historyToMessages(entries as never), true, recs).find(c => c.callId === 'call-single-1')!;
  expect(child.status).toBe('running');
  expect(child.startedAt).toBe(now - 9000);
  let html = renderChild(child, msgs);
  expect(elapsedText(html)).toMatch(/已工作|Working for/);

  writeRun(env, 'run-single-1', status('complete'));
  recs = await recoverSubagents(env.root, KEY, index as never) as RecoveredSubagent[];
  child = projectSubagents(historyToMessages(entries as never), true, recs).find(c => c.callId === 'call-single-1')!;
  expect(child.status).toBe('completed');
  expect(child.startedAt).toBe(now - 9000);
  expect(child.endedAt).toBe(now - 2000); // 已验证终态的真实 lastUpdate
  html = renderChild(child, msgs);
  expect(elapsedText(html)).toBe(zh ? '用时 7秒' : 'Took 7s'); // 9000-2000=7000ms，不夸大不缩小
});

it('149-2 orphan 终态：顶层状态口径统一，completed/failed 都有真实用时（DOM）', async () => {
  const zh = usePiStore.getState().lang !== 'en';
  const now = Date.now();
  const env = mkEnv();
  writeRun(env, 'run-orphan-ok', { mode: 'single', runId: 'run-orphan-ok', sessionId: env.sessionFile, state: 'complete', startedAt: now - 90000, lastUpdate: now - 80000, steps: [{ agent: 'scout' }] });
  writeRun(env, 'run-orphan-bad', { mode: 'single', runId: 'run-orphan-bad', sessionId: env.sessionFile, state: 'failed', startedAt: now - 50000, lastUpdate: now - 44000, steps: [{ agent: 'worker' }] });
  const recs = await recoverSubagents(env.root, KEY, { subagentHistory: () => emptyHistory(env) } as never) as RecoveredSubagent[];
  // 统一口径：顶层 status 是已验证的规范化状态，不再是恒 unknown。
  expect(recs.find(r => r.callId === 'run-orphan-ok')!.status).toBe('completed');
  expect(recs.find(r => r.callId === 'run-orphan-bad')!.status).toBe('failed');
  const children = projectSubagents([], false, recs);
  const ok = children.find(c => c.callId === 'run-orphan-ok')!;
  const bad = children.find(c => c.callId === 'run-orphan-bad')!;
  expect(ok.status).toBe('completed');
  expect(ok.startedAt).toBe(now - 90000);
  expect(ok.endedAt).toBe(now - 80000);
  expect(bad.status).toBe('failed');
  expect(bad.startedAt).toBe(now - 50000);
  expect(bad.endedAt).toBe(now - 44000);
  for (const [child, secs] of [[ok, 10], [bad, 6]] as const) {
    const html = renderChild(child, [{ role: 'assistant', content: [{ type: 'text', text: 'work' }] }]);
    expect(elapsedText(html)).toBe(zh ? `用时 ${secs}秒` : `Took ${secs}s`);
  }
});

it('149-2 orphan 仍 running：不把轮询时刻当结束时刻（无 endedAt、无用时 DOM）', async () => {
  const now = Date.now();
  const env = mkEnv();
  writeRun(env, 'run-orphan-live', { mode: 'single', runId: 'run-orphan-live', sessionId: env.sessionFile, state: 'running', startedAt: now - 30000, lastUpdate: now - 1000, steps: [{ agent: 'scout' }] });
  const recs = await recoverSubagents(env.root, KEY, { subagentHistory: () => emptyHistory(env) } as never) as RecoveredSubagent[];
  expect(recs[0]!.status).toBe('running');
  const child = projectSubagents([], false, recs).find(c => c.callId === 'run-orphan-live')!;
  expect(child.status).toBe('running');
  expect(child.startedAt).toBe(now - 30000);
  expect(child.endedAt).toBeUndefined();
  const html = renderChild(child, [{ role: 'assistant', content: [{ type: 'text', text: 'work' }] }]);
  expect(elapsedText(html)).toMatch(/已工作|Working for/); // 运行中照样有真实已工作
});

it('149-3 workflow 兄弟各用各的时钟：不用父起点，无 child 时间不显示（DOM）', async () => {
  const zh = usePiStore.getState().lang !== 'en';
  const now = Date.now();
  const env = mkEnv();
  const wf = 'run-wf-149';
  // 父 workflow 90s 前开始仍运行；A 80s 前开始、70s 前完成；B 20s 前开始仍运行；C 未派生。
  writeRun(env, wf, {
    mode: 'workflow', runId: wf, sessionId: env.sessionFile, toolCallId: wf, state: 'running', startedAt: now - 90000, lastUpdate: now - 1000,
    workflowChildren: { version: 1, parentToolCallId: wf, workflowRunId: wf, inventoryComplete: true, workflowState: 'running', children: [
      { childId: 'step-0', runId: 'run-wf-a', agent: 'alpha', state: 'completed' },
      { childId: 'step-1', runId: 'run-wf-b', agent: 'beta', state: 'running' },
      { childId: 'step-2', agent: 'gamma', state: 'queued' },
    ] },
  });
  writeRun(env, 'run-wf-a', { mode: 'single', runId: 'run-wf-a', sessionId: env.sessionFile, toolCallId: 'ct-a', parentWorkflowRunId: wf, workflowKey: 'step-0', state: 'complete', startedAt: now - 80000, lastUpdate: now - 70000 });
  writeRun(env, 'run-wf-b', { mode: 'single', runId: 'run-wf-b', sessionId: env.sessionFile, toolCallId: 'ct-b', parentWorkflowRunId: wf, workflowKey: 'step-1', state: 'running', startedAt: now - 20000, lastUpdate: now - 1000 });
  const recs = await recoverSubagents(env.root, KEY, { subagentHistory: () => emptyHistory(env) } as never) as RecoveredSubagent[];
  const children = projectSubagents([], false, recs);
  const a = children.find(c => c.childKey === 'step-0')!;
  const b = children.find(c => c.childKey === 'step-1')!;
  const c = children.find(c => c.childKey === 'step-2')!;
  // A：自己的起点/终点，不是父 workflow 的。
  expect(a.status).toBe('completed');
  expect(a.startedAt).toBe(now - 80000);
  expect(a.endedAt).toBe(now - 70000);
  // B：自己的起点；运行中无终点（lastUpdate 是轮询时刻）。
  expect(b.status).toBe('running');
  expect(b.startedAt).toBe(now - 20000);
  expect(b.endedAt).toBeUndefined();
  // C：queued 且无 runId → 无已验证时间，也不拿父时间兜底。
  expect(c.startedAt).toBeUndefined();
  const ha = renderChild(a, [{ role: 'assistant', content: [{ type: 'text', text: 'work' }] }]);
  expect(elapsedText(ha)).toBe(zh ? '用时 10秒' : 'Took 10s');
  const hb = renderChild(b, [{ role: 'assistant', content: [{ type: 'text', text: 'work' }] }]);
  const bText = elapsedText(hb)!;
  // B 的已工作必须在 18~40s 内（自己的 20s 起点）；父起点会渲染成 ~1m30s，不允许。
  expect(bText).toMatch(zh ? /^已工作 (1[89]|2\d|3\d)秒$/ : /^Working for (1[89]|2\d|3\d)s$/);
  const hc = renderChild(c, [{ role: 'assistant', content: [{ type: 'text', text: 'work' }] }]);
  expect(elapsedText(hc)).toBeUndefined();
});

it('EMPTY：零 assistant 消息不声称已恢复计时（无 elapsed DOM，不造虚拟消息）', () => {
  const html = renderToStaticMarkup(React.createElement(Transcript, { messages: [], turnKey: 'empty-k', live: true, startedAt: Date.now() - 5000 } as never));
  expect(/pi-execution__elapsed/.test(html)).toBe(false);
});
