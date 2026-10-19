import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { persistSubagentEvent, runningSubagentCounts } from '../src/main/pi/official-subagent';
import { buildPiSidebar } from '../src/renderer/pi/adapter';
import type { PiRun } from '../src/shared/pi';

// 侧栏菊花覆盖子代理（用户 2026-10-17）：主 run 已结束但会话仍有子代理在跑时，
// 侧栏会话行的 loading 标识不能停——否则用户误以为任务已结束。
const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(p => fs.rmSync(p, { recursive: true, force: true })); });

const sessionA = 'a'.repeat(64);
const sessionB = 'b'.repeat(64);

function setupAgentDir() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sidebar-subagent-busy-')));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'subagents'), { recursive: true });
  return root;
}

describe('runningSubagentCounts', () => {
  it('counts fresh running snapshots per session and ignores stale/terminal/corrupt', () => {
    const agentDir = setupAgentDir();
    const now = Date.now();
    const write = (name: string, snap: unknown) => fs.writeFileSync(path.join(agentDir, 'subagents', name), JSON.stringify(snap));
    write(`${sessionA}_call_1.json`, { callId: 'call_1', status: 'running', updatedAt: now });
    write(`${sessionA}_call_2.json`, { callId: 'call_2', status: 'running', updatedAt: now - 1000 });
    write(`${sessionA}_call_3.json`, { callId: 'call_3', status: 'completed', updatedAt: now });          // 终态不计
    write(`${sessionA}_call_4.json`, { callId: 'call_4', status: 'running', updatedAt: now - 10 * 60 * 1000 }); // stale 不计（菊花不能永转）
    write(`${sessionA}_call_5.json`, { callId: 'call_5', status: 'running' });                             // 无 updatedAt 不计
    write(`${sessionB}_call_6.json`, { callId: 'call_6', status: 'running', updatedAt: now });
    fs.writeFileSync(path.join(agentDir, 'subagents', `${sessionA}_broken.json`), '{ not json');
    fs.writeFileSync(path.join(agentDir, 'subagents', 'not-a-session.json'), JSON.stringify({ status: 'running', updatedAt: now }));
    const counts = runningSubagentCounts(agentDir, now);
    expect(counts).toEqual({ [sessionA]: 2, [sessionB]: 1 });
  });

  it('sweeps stale running snapshots so ghost rows cannot survive an agent end', () => {
    const agentDir = setupAgentDir();
    const now = Date.now();
    const stale = `${sessionA}_call_stale.json`;
    const fresh = `${sessionA}_call_fresh.json`;
    fs.writeFileSync(path.join(agentDir, 'subagents', stale), JSON.stringify({ callId: 'call_stale', status: 'running', updatedAt: now - 10 * 60 * 1000 }));
    fs.writeFileSync(path.join(agentDir, 'subagents', fresh), JSON.stringify({ callId: 'call_fresh', status: 'running', updatedAt: now }));
    const counts = runningSubagentCounts(agentDir, now, { sweep: true });
    expect(counts).toEqual({ [sessionA]: 1 });
    // 删除会让 pointers() 的崩溃调用补齐失效（详情卡片与 transcript 指针全消失）：
    // sweep 必须改写为终态而不是 unlink。
    const rewritten = JSON.parse(fs.readFileSync(path.join(agentDir, 'subagents', stale), 'utf8'));
    expect(rewritten.status).toBe('interrupted');
    expect(fs.existsSync(path.join(agentDir, 'subagents', fresh))).toBe(true);
    // 幂等：第二次 sweep 不改写已终态的条目（无谓写盘）。
    const before = fs.statSync(path.join(agentDir, 'subagents', stale)).mtimeMs;
    runningSubagentCounts(agentDir, now, { sweep: true });
    expect(fs.statSync(path.join(agentDir, 'subagents', stale)).mtimeMs).toBe(before);
  });

  it('returns {} when the snapshot dir is missing', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sidebar-subagent-busy-')));
    roots.push(root);
    expect(runningSubagentCounts(root)).toEqual({});
  });

  it('async observations override frozen running tool snapshots, including a completed async run', () => {
    const agentDir = setupAgentDir(), now = Date.now();
    fs.writeFileSync(path.join(agentDir, 'subagents', sessionA + '_call-one.json'), JSON.stringify({ callId: 'call-one', status: 'running', updatedAt: now }));
    expect(runningSubagentCounts(agentDir, now, { observedCalls: new Set([sessionA + ':call-one']) })).toEqual({});
  });

  it('reflects persistSubagentEvent lifecycle (running → completed drops the count)', () => {
    const agentDir = setupAgentDir();
    persistSubagentEvent(agentDir, sessionA, 'call_x', { type: 'tool_execution_start', toolName: 'subagent' });
    expect(runningSubagentCounts(agentDir)[sessionA]).toBe(1);
    persistSubagentEvent(agentDir, sessionA, 'call_x', { type: 'tool_execution_end', toolName: 'subagent', result: {} });
    expect(runningSubagentCounts(agentDir)[sessionA]).toBeUndefined();
  });
});

describe('buildPiSidebar busy with running subagents', () => {
  const run = (over: Partial<PiRun>): PiRun => ({ key: sessionA, generation: 'g', cwd: '/x', file: '/x/s.jsonl', status: 'idle', models: [], commands: [], pending: 0, ...over } as PiRun);

  it('keeps the row busy while subagents run after the main run went idle', () => {
    const result = buildPiSidebar([], [run({ status: 'idle', runningSubagents: 2 })], [], {}, { projects: [] }, []);
    expect(result.projects.flatMap(p => p.sessions).concat(result.temporary).some(s => s.busy)).toBe(true);
  });

  it('stays idle when no subagents run and the main run is idle', () => {
    const result = buildPiSidebar([], [run({ status: 'idle', runningSubagents: 0 })], [], {}, { projects: [] }, []);
    expect(result.projects.flatMap(p => p.sessions).concat(result.temporary).every(s => !s.busy)).toBe(true);
  });

  it('preserves the legacy behavior when the field is absent', () => {
    const result = buildPiSidebar([], [run({ status: 'idle' })], [], {}, { projects: [] }, []);
    expect(result.projects.flatMap(p => p.sessions).concat(result.temporary).every(s => !s.busy)).toBe(true);
    const running = buildPiSidebar([], [run({ status: 'running' })], [], {}, { projects: [] }, []);
    expect(running.projects.flatMap(p => p.sessions).concat(running.temporary).every(s => s.busy)).toBe(true);
  });
});
