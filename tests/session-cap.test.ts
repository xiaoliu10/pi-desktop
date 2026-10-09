import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PiBackend } from '../src/main/pi/backend';
import { SessionIndex, fileKey } from '../src/main/pi/session-index';
import { PiRpcClient } from '../src/main/pi/rpc-client';
import type { PiEnvironment } from '../src/shared/pi';

// 会话连接上限：12 个硬上限；满员时自动断开最久空闲的 idle 会话腾位（历史无损，点开即重连）。
const dirs: string[] = [], backends: PiBackend[] = [], clients: PiRpcClient[] = [];
afterEach(() => {
  backends.splice(0).forEach(b => b.dispose());
  clients.splice(0).forEach(c => c.close());
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const env = (): PiEnvironment => ({ executable: path.resolve('tests/fixtures/fake-pi.mjs'), version: '0.85.1', supported: true, agentDir: '/tmp/agent', sessionDirs: [], diagnostics: [] });

function setup(count: number) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-cap-')); dirs.push(root);
  const owned = path.join(root, 'desktop'); fs.mkdirSync(owned, { recursive: true });
  const index = new SessionIndex([root, owned], owned);
  const backend = new PiBackend(env(), index, owned, path.resolve('extensions/desktop-policy/index.mjs'), () => undefined);
  backends.push(backend);
  const keys: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const file = path.join(owned, `s${i}.jsonl`);
    fs.writeFileSync(file, JSON.stringify({ type: 'session', version: 3, id: `s${i}`, cwd: root, timestamp: new Date().toISOString() }) + '\n');
    keys.push(fileKey(file));
  }
  return { root, owned, backend, keys };
}
const connectAll = async (s: ReturnType<typeof setup>) => {
  for (const key of s.keys) await s.backend.connect({ sourceKey: key, cwd: s.root, trustProject: false, permission: 'ask' });
};

describe('会话连接上限（12）与空闲腾位', () => {
  it('12 个会话全部可连接（旧上限 6 已放宽）', async () => {
    const s = setup(12);
    await connectAll(s);
    expect(s.backend.runs()).toHaveLength(12);
  });

  it('第 13 个连接自动断开最久空闲的会话腾位，新会话成功', async () => {
    const s = setup(12);
    await connectAll(s); // 满 12 个
    expect(s.backend.runs()).toHaveLength(12);
    const oldest = s.keys[0]!;
    expect(s.backend.runs().some(r => r.key === oldest)).toBe(true);
    const extra = path.join(s.owned, 'extra.jsonl');
    fs.writeFileSync(extra, JSON.stringify({ type: 'session', version: 3, id: 'extra', cwd: s.root, timestamp: new Date().toISOString() }) + '\n');
    await s.backend.connect({ sourceKey: fileKey(extra), cwd: s.root, trustProject: false, permission: 'ask' });
    const runs = s.backend.runs();
    expect(runs).toHaveLength(12); // 腾位后总数仍为 12
    expect(runs.some(r => r.key === oldest)).toBe(false); // 最久空闲被断开
    expect(runs.some(r => r.key === fileKey(extra))).toBe(true);
  });

  it('腾位不选「追问已保留」的会话：排队输入不能被静默丢弃', async () => {
    const s = setup(12);
    await connectAll(s);
    // 白盒注入：keys[0] 是 idle 但挂着未恢复的排队追问（close 会清空 deferredQueue）
    const guarded = (s.backend as unknown as { active: Map<string, { deferredQueue: unknown[] }> }).active.get(s.keys[0]!)!;
    guarded.deferredQueue.push({ text: '排队中的追问', behavior: 'followUp' });
    const extra = path.join(s.owned, 'extra.jsonl');
    fs.writeFileSync(extra, JSON.stringify({ type: 'session', version: 3, id: 'extra', cwd: s.root, timestamp: new Date().toISOString() }) + '\n');
    await s.backend.connect({ sourceKey: fileKey(extra), cwd: s.root, trustProject: false, permission: 'ask' });
    const runs = s.backend.runs();
    expect(runs.some(r => r.key === s.keys[0])).toBe(true); // 带排队输入的会话幸存
    expect(runs.some(r => r.key === s.keys[1])).toBe(false); // 腾的是下一个最久空闲
    expect(runs.some(r => r.key === fileKey(extra))).toBe(true);
  });

  it('腾位不选运行中的会话：全繁忙时拒绝并给出可执行文案', async () => {
    const s = setup(12);
    await connectAll(s);
    for (const key of s.keys) await s.backend.prompt(key, '/long', 'followUp');
    await vi.waitFor(() => expect(s.backend.runs().every(r => r.status === 'running')).toBe(true));
    const extra = path.join(s.owned, 'extra.jsonl');
    fs.writeFileSync(extra, JSON.stringify({ type: 'session', version: 3, id: 'extra', cwd: s.root, timestamp: new Date().toISOString() }) + '\n');
    await expect(s.backend.connect({ sourceKey: fileKey(extra), cwd: s.root, trustProject: false, permission: 'ask' }))
      .rejects.toThrow('都在运行或等待交互');
    expect(s.backend.runs()).toHaveLength(12);
  });
});
