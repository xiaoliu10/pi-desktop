import { describe, expect, it, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// secrets.ts 依赖 electron safeStorage；测试环境用明文回退路径（与 voice-service.test.ts 同款）。
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b,
  },
}));

const { TunnelService } = await import('../src/main/pi/tunnel-service');

/**
 * 回归：app 重启后隧道必须自动恢复。用户实测：启用过隧道后重启 Desktop，
 * 配置里 enabled=true（按钮显示「关闭隧道」）但状态永远停在「未开启」——
 * 因为 sync() 只在点按钮（save）时被调用，启动路径没有任何恢复逻辑。
 */
describe('TunnelService 启动恢复', () => {
  const tmpDirs: string[] = [];
  afterEach(() => { for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

  function writeConfig(dir: string, cfg: object): string {
    const file = path.join(dir, 'tunnel.json');
    fs.writeFileSync(file, JSON.stringify(cfg));
    return file;
  }

  it('enabled=true 时 startup() 拉起 LAN 并重连 relay', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-boot-'));
    tmpDirs.push(dir);
    writeConfig(dir, { enabled: true, relayUrl: 'https://relay.example.com:8443', keyEncrypted: 'k-enc', deviceName: 'mbp' });
    const ensureCalls: number[] = [];
    const okFetch = vi.fn(async () => new Response(JSON.stringify({ code: 0, data: { device_sid: 'sid', token: 'tok', expires_in: 60 } }), { status: 200 }));
    const service = new TunnelService(path.join(dir, 'tunnel.json'), {
      localBase: () => 'http://127.0.0.1:1',
      localToken: () => 'tok',
      ensureLocal: () => { ensureCalls.push(1); },
      relayFetch: okFetch as unknown as typeof fetch,
      wsFactory: () => ({ send: () => {}, close: () => {}, on: () => {} }) as never,
    });
    await service.startup();
    expect(ensureCalls.length).toBe(1); // LAN 被自动拉起
    const status = await service.status();
    expect(status.enabled).toBe(true);
    expect(status.state).toBe('connecting'); // 已开始连接（wsFactory stub 不会 open）
    expect(status.relayUrl).toBe('https://relay.example.com:8443');
    service.stop();
  });

  it('enabled=false（或无配置）时 startup() 不做任何事', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-boot-'));
    tmpDirs.push(dir);
    writeConfig(dir, { enabled: false, relayUrl: '', deviceName: '' });
    const ensureCalls: number[] = [];
    const service = new TunnelService(path.join(dir, 'tunnel.json'), {
      localBase: () => 'http://127.0.0.1:1',
      localToken: () => 'tok',
      ensureLocal: () => { ensureCalls.push(1); },
    });
    await service.startup();
    expect(ensureCalls.length).toBe(0);
    const status = await service.status();
    expect(status.state).toBe('stopped');
  });

  it('LAN 拉起失败不阻断 relay 连接建立（localBase 惰性）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-boot-'));
    tmpDirs.push(dir);
    writeConfig(dir, { enabled: true, relayUrl: 'https://relay.example.com:8443', keyEncrypted: 'k-enc', deviceName: '' });
    const okFetch = vi.fn(async () => new Response(JSON.stringify({ code: 0, data: { device_sid: 'sid', token: 'tok', expires_in: 60 } }), { status: 200 }));
    const service = new TunnelService(path.join(dir, 'tunnel.json'), {
      localBase: () => { throw new Error('LAN 远控未运行'); },
      localToken: () => 'tok',
      ensureLocal: () => { throw new Error('端口被占'); },
      relayFetch: okFetch as unknown as typeof fetch,
      wsFactory: () => ({ send: () => {}, close: () => {}, on: () => {} }) as never,
    });
    await expect(service.startup()).resolves.not.toThrow();
    const status = await service.status();
    expect(status.state).toBe('connecting'); // relay 照常连接；LAN 失败只影响转发
  });
});
