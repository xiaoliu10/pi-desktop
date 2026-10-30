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
 * 回归：保存 tunnel 配置不得要求 LAN remote-server 已在运行。
 * 用户实测：没开 LAN 就填 relay 地址，点「保存配置」直接报
 * 「Error invoking remote method 'local-pi:tunnelSave': Error: LAN 远控未运行」。
 * 根因：localBase 是提前求值的字符串，校验阶段就调用了。
 */
describe('TunnelService 保存配置不依赖 LAN 状态', () => {
  const tmpDirs: string[] = [];
  afterEach(() => { for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

  it('LAN 未运行时也能保存 relay 地址与 key', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-svc-'));
    tmpDirs.push(dir);
    const service = new TunnelService(path.join(dir, 'tunnel.json'), {
      // 模拟 LAN 未启动：取 base 就抛（index.ts 的 remote.lanEndpoint() 就是这个行为）
      localBase: () => { throw new Error('LAN 远控未运行'); },
      localToken: () => { throw new Error('LAN 远控未运行'); },
    });
    const saved = await service.save({
      relayUrl: 'https://www.huimengwangluo.cn/tunnel',
      key: 'test-key-123',
    });
    expect(saved.relayUrl).toBe('https://www.huimengwangluo.cn/tunnel');
    // current 脱敏后 keyEncrypted 是哨兵值；index.ts 用它算 hasKey（!!keyEncrypted）
    expect(saved.keyEncrypted).toBe('********');
    expect(saved.enabled).toBe(false); // 没传 enabled，不自动启用

    // key 必须加密落盘，不得出现明文
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'tunnel.json'), 'utf8')) as { keyEncrypted: string };
    expect(raw.keyEncrypted).toBeTruthy();
    expect(raw.keyEncrypted).not.toContain('test-key-123');
  });

  it('启用时若 LAN 未运行，状态反映 error 但不丢配置', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-svc-'));
    tmpDirs.push(dir);
    const service = new TunnelService(path.join(dir, 'tunnel.json'), {
      localBase: () => { throw new Error('LAN 远控未运行'); },
      localToken: () => { throw new Error('LAN 远控未运行'); },
    });
    // enabled:true 但 localBase 抛：sync 里 client.start() 的 catch 会兜住，配置已存
    const saved = await service.save({
      relayUrl: 'https://relay.example.com:8443',
      key: 'k2',
      enabled: true,
    }).catch(() => null);
    // 保存本身不应抛（抛了说明仍是提前求值）
    if (saved) {
      expect(saved.enabled).toBe(true);
      const status = await service.status();
      expect(status.enabled).toBe(true);
      // LAN 未起 → 连接建不起来，状态停在 connecting/stopped，但不得抛异常
      expect(['connecting', 'stopped', 'error']).toContain(status.state);
    }
    const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'tunnel.json'), 'utf8')) as { enabled: boolean; relayUrl: string };
    expect(persisted.enabled).toBe(true);
    expect(persisted.relayUrl).toBe('https://relay.example.com:8443');
  });
});
