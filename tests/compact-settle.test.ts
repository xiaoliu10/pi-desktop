import { describe, expect, it, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PiBackend } from '../src/main/pi/backend';
import { SessionIndex } from '../src/main/pi/session-index';
import { PiRpcClient } from '../src/main/pi/rpc-client';
import type { PiEvent } from '../src/shared/pi';

// 用户 2026-11-03 反馈：ashare 会话（518MB）手动压缩耗时 143 秒后失败（tokensAfter=null），
// 之后 UI 永久停在「已工作 9:55」+ 转圈，停止按钮也解不开。
//
// 根因：compaction_start 把 view.status 置 'running'（backend.ts:698），而 compaction_end
// 只复位 compacting、从不复位 status/timing.endedAt。手动 /compact 不走 agent_start/
// agent_settled，于是：
//   · RPC compact 超时（大会话常态）→ settled=false → settleAfterCompact 不收口
//   · 随后 compaction_end 到达 → 只清 compacting → status 仍是 'running'
// 结果状态机死锁：没有事件能再把它拉回 idle，计时条永续。
//
// 本测试断言：无论 compact RPC 成功/超时/失败，compaction_end 之后会话必须回到空闲。
const roots: string[] = [];
const backends: PiBackend[] = [];
afterEach(() => { backends.splice(0).forEach(b => b.dispose()); roots.splice(0).forEach(p => fs.rmSync(p, { recursive: true, force: true })); });

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-settle-'));
  roots.push(root);
  const owned = path.join(root, 'desktop');
  fs.mkdirSync(owned, { recursive: true });
  const events: PiEvent[] = [];
  const backend = new PiBackend(
    { executable: process.execPath, supported: true, agentDir: root, sessionDirs: [root], diagnostics: [] },
    new SessionIndex([owned], owned), owned, path.resolve('extensions/desktop-policy/index.mjs'),
    e => events.push(structuredClone(e)));
  backends.push(backend);
  let rpc!: PiRpcClient;
  backend.clientFactory = (_cmd, args, cwd, env) => (rpc = new PiRpcClient(process.execPath, [path.resolve('tests/fixtures/fake-pi.mjs'), ...args], cwd, env));
  return { root, backend, events, getRpc: () => rpc };
}

describe('手动压缩结束时状态必须收口（防「已工作」永续 + 关不掉）', () => {
  it('compaction_start 后 compaction_end（即使无 agent_settled）必须回到 idle 并写 endedAt', async () => {
    const { backend, events, getRpc } = setup();
    const run = await backend.connect({ cwd: path.dirname(roots[0]), trustProject: false, permission: 'ask' });
    const rpc = getRpc();

    await rpc.request('emit_events', { events: [{ type: 'compaction_start' }] });
    await vi.waitFor(() => expect(backend.get(run.key).view.status).toBe('running'));

    // 失败压缩：pi 只发 compaction_end（result 缺失），且手动 /compact 从无 agent_settled。
    await rpc.request('emit_events', { events: [{ type: 'compaction_end' }] });
    await vi.waitFor(() => expect(backend.get(run.key).view.compacting).toBe(false));

    expect(backend.get(run.key).view.status).toBe('idle');
    expect(backend.get(run.key).view.timing?.endedAt).toBeTypeOf('number');
    // 计时条据此从「已工作」切「用时」，不再每秒增长。
    expect(events.some(e => e.type === 'run' && e.run.timing?.endedAt !== undefined)).toBe(true);
  });

  it('压缩期间有排队输入时不误清队列，但状态仍收口', async () => {
    const { backend, getRpc } = setup();
    const run = await backend.connect({ cwd: path.dirname(roots[0]), trustProject: false, permission: 'ask' });
    const rpc = getRpc();
    await rpc.request('emit_events', { events: [{ type: 'compaction_start' }] });
    await vi.waitFor(() => expect(backend.get(run.key).view.status).toBe('running'));
    await rpc.request('emit_events', { events: [{ type: 'compaction_end' }] });
    await vi.waitFor(() => expect(backend.get(run.key).view.status).toBe('idle'));
    expect(backend.get(run.key).view.queue ?? []).toEqual([]);
  });
});
