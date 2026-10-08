import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PiBackend } from '../src/main/pi/backend';
import { SessionIndex, fileKey } from '../src/main/pi/session-index';
import { PiRpcClient } from '../src/main/pi/rpc-client';
import type { PiEnvironment } from '../src/shared/pi';

// 内置 /reload：Desktop 等价实现 = 重启 pi 重连同一会话（pi RPC 无 reload 命令，
// 直接 prompt('/reload') 会被当普通文本发给模型）。委托 refresh：guard 与
// executionMode/timing 保留全继承；历史经 session 文件完整保留。
const dirs: string[] = [], backends: PiBackend[] = [], clients: PiRpcClient[] = [];
afterEach(() => {
  backends.splice(0).forEach(b => b.dispose());
  clients.splice(0).forEach(c => c.close());
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const env = (): PiEnvironment => ({ executable: path.resolve('tests/fixtures/fake-pi.mjs'), version: '0.85.1', supported: true, agentDir: '/tmp/agent', sessionDirs: [], diagnostics: [] });

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-reload-')); dirs.push(root);
  const owned = path.join(root, 'desktop'); fs.mkdirSync(owned, { recursive: true });
  const file = path.join(owned, 's.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'session', version: 3, id: 'r', cwd: root, timestamp: new Date().toISOString() }) + '\n');
  const index = new SessionIndex([root, owned], owned);
  const backend = new PiBackend(env(), index, owned, path.resolve('extensions/desktop-policy/index.mjs'), () => undefined);
  backends.push(backend);
  const spawns: { args: string[]; cwd: string }[] = [];
  backend.clientFactory = (cmd, args, cwd, e) => { spawns.push({ args, cwd }); const c = new PiRpcClient(cmd, args, cwd, e); clients.push(c); return c; };
  return { root, owned, file, key: fileKey(file), backend, spawns: () => spawns };
}

describe('内置 /reload：重启 pi 重连同一会话', () => {
  it('idle 下 reload：重开新进程指向同一会话文件、同 key、回 idle、无错误条，mode 文件保留', async () => {
    const s = setup();
    const first = await s.backend.connect({ sourceKey: s.key, cwd: s.root, trustProject: false, permission: 'ask' });
    expect(first.status).toBe('idle');
    expect(s.spawns()).toHaveLength(1);
    // mode 文件在（连接时写入）：reload 的 close→launch 不得把它删没（异步 rm 竞态曾中招）
    const modeFile = path.join(s.owned, `.mode-${s.key}`);
    expect(fs.existsSync(modeFile)).toBe(true);
    await s.backend.reloadSession(s.key);
    expect(s.spawns()).toHaveLength(2); // 旧进程被替换，新进程拉起
    const last = s.spawns().at(-1)!;
    const sessionIdx = last.args.indexOf('--session');
    expect(sessionIdx).toBeGreaterThanOrEqual(0);
    expect(last.args[sessionIdx + 1]).toBe(fs.realpathSync(s.file)); // 重连指向同一会话文件（历史完整保留的数据基础；launch 会 realpath，macOS /var→/private/var）
    await vi.waitFor(() => {
      const runs = s.backend.runs();
      expect(runs).toHaveLength(1);
      expect(runs[0]!.key).toBe(s.key);
      expect(runs[0]!.status).toBe('idle');
      expect(runs[0]!.error).toBeUndefined();
    });
    expect(fs.existsSync(modeFile)).toBe(true); // close 的同步 rm + launch 重写：文件不缺位
  });

  it('非 idle（运行中）拒绝重载（委托 refresh 的 guard）', async () => {
    const s = setup();
    await s.backend.connect({ sourceKey: s.key, cwd: s.root, trustProject: false, permission: 'ask' });
    await s.backend.prompt(s.key, '/long', 'followUp');
    await vi.waitFor(() => expect(s.backend.runs()[0]!.status).toBe('running'));
    await expect(s.backend.reloadSession(s.key)).rejects.toThrow('请完成或停止');
    expect(s.spawns()).toHaveLength(1); // 未重启
    await s.backend.stop(s.key);
  });

  it('未连接的 key 拒绝重载', async () => {
    const s = setup();
    await expect(s.backend.reloadSession(s.key)).rejects.toThrow('会话未连接');
  });
});
