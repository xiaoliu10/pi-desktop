// 0.1.32 打包环境第三个连环 bug 的回归测试：Electron utilityProcess 的
// process.parentPort 是 MessagePortMain，'message' 回调收到的是 MessageEvent
// { data, ports }——裸消息在 data 里（与 renderer MessagePort 同语义，实测
// 2026-10-20：main 侧 child.postMessage({op:'ping'})，worker 收到
// { data: {op:'ping'}, ports: [] }）。child→main 方向却是裸消息（非对称）。
//
// index-worker-entry 曾把回调参数当裸消息读：raw.id/raw.op 永远 undefined →
// 静默 return → 所有入站请求石沉大海 → client 60s 超时判死 → 200ms/1s/3s 重启
// 循环（出站 sessions/ready 事件正常，所以会话列表有数据但打开会话永远加载）。
// in-process（vitest）与 child_process.fork 探针走 Node IPC 裸消息，恰好全部
// 绕过这个形状——只有真实 utility process 会踩中。
//
// 本测试模拟真实 Electron 形状驱动 main()：mock process.parentPort，以
// { data, ports } 包装投递请求，断言收到裸应答。修复前红（无应答超时），修复后绿。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

interface MockPort {
  postMessage(v: unknown): void;
  on(event: 'message', cb: (v: unknown) => void): void;
  /** 模拟 Electron 投递（MessageEvent 包装）。 */
  deliverElectron(v: unknown): void;
  /** 模拟 Node child_process 投递（裸消息）。 */
  deliverNode(v: unknown): void;
  sent: unknown[];
}

function mockParentPort(): MockPort {
  const listeners: ((v: unknown) => void)[] = [];
  const sent: unknown[] = [];
  return {
    sent,
    postMessage(v) { sent.push(v); },
    on(_e, cb) { listeners.push(cb); },
    deliverElectron(v) { for (const cb of listeners) cb({ data: v, ports: [] }); },
    deliverNode(v) { for (const cb of listeners) cb(v); },
  };
}

async function bootWorker(): Promise<MockPort> {
  vi.resetModules();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idx-chan-test-'));
  const owned = path.join(dir, 'owned');
  fs.mkdirSync(owned, { recursive: true });
  const config = { roots: [dir], ownedRoot: owned, agentDir: dir, outlineCachePath: path.join(dir, 'outline.json'), metaCachePath: path.join(dir, 'meta.json') };
  const port = mockParentPort();
  (process as unknown as { parentPort?: unknown }).parentPort = port;
  process.argv.push(JSON.stringify(config));
  await import('../src/main/pi/index-worker-entry');
  return port;
}

afterEach(() => {
  delete (process as unknown as { parentPort?: unknown }).parentPort;
  process.argv = process.argv.filter(a => !a.startsWith('{"roots"'));
});

it('electron-shaped {data,ports} request gets a bare reply', async () => {
  const port = await bootWorker();
  // main() 同步完成冷扫（空目录）并发出 sessions/ready。
  expect(port.sent.some(m => (m as { ev?: string }).ev === 'ready')).toBe(true);
  port.deliverElectron({ id: 1, op: 'usageStats' });
  // 空目录聚合是同步的；投递后同拍即应有应答。
  await vi.waitFor(() => {
    const reply = port.sent.find(m => (m as { id?: number }).id === 1) as { ok?: boolean; value?: unknown } | undefined;
    expect(reply, '包装消息被静默丢弃（0.1.32 打包环境 worker 入站全死）').toBeDefined();
    expect(reply!.ok).toBe(true);
  }, { timeout: 2000, interval: 20 });
});

it('bare node-IPC-shaped request keeps working (child_process.fork path)', async () => {
  const port = await bootWorker();
  port.deliverNode({ id: 2, op: 'usageStats' });
  await vi.waitFor(() => {
    const reply = port.sent.find(m => (m as { id?: number }).id === 2) as { ok?: boolean } | undefined;
    expect(reply).toBeDefined();
    expect(reply!.ok).toBe(true);
  }, { timeout: 2000, interval: 20 });
});
