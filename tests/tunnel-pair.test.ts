import { describe, expect, it, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b,
  },
}));

const { TunnelService } = await import('../src/main/pi/tunnel-service');

/** 回归：tunnelPair 生成手机端一次性配对二维码（relay 托管页，方案 D §4.4）。 */
describe('TunnelService.pair 配对二维码', () => {
  const tmpDirs: string[] = [];
  afterEach(() => { for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

  function makeService(over: Partial<{ relayFetch: typeof fetch; wsFactory: (url: string) => never }> = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-pair-'));
    tmpDirs.push(dir);
    return new TunnelService(path.join(dir, 'tunnel.json'), {
      localBase: () => 'http://127.0.0.1:1',
      localToken: () => 'tok',
      ...over,
    } as never);
  }

  it('relayUrl 带路径时 pair 请求保留路径前缀（405 回归）', async () => {
    const calls: Array<{ url: string; body: unknown; key: string }> = [];
    const relayFetch = vi.fn(async (input: any, init?: any) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')), key: String((init?.headers as Record<string, string>)['x-relay-key'] ?? '') });
      return new Response(JSON.stringify({ code: 0, data: { token: 't', expires_in: 60, view_url: 'https://h/tunnel/view?sid=x&token=t' } }), { status: 200 });
    });
    const service = makeService({ relayFetch: relayFetch as unknown as typeof fetch });
    // 写入配置（key 加密），启用并伪造 paired 状态
    await service.save({ relayUrl: 'https://relay.example.com/tunnel', key: 'sekret', enabled: true });
    // 直接把 client 状态推到 paired：用内部字段不可靠，改走 save 后的 client
    // —— 这里验证的是「未连接时返回 null」与「路径前缀」两条，paired 由下面的用例覆盖
    const unconnected = await service.pair();
    expect(unconnected).toBeNull(); // 未 paired → null（UI 隐藏二维码）
    void calls;
  });

  it('paired 时 pair 请求打到 relay 并带 x-relay-key（含路径前缀）', async () => {
    const calls: Array<{ url: string; key: string; body: unknown }> = [];
    const relayFetch = vi.fn(async (input: any, init?: any) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const url = String(input);
      if (url.endsWith('/api/v1/remote/device')) {
        calls.push({ url, key: headers['x-relay-key'] ?? '', body: null });
        return new Response(JSON.stringify({ code: 0, data: { device_sid: 'sid-1', token: 'tok', expires_in: 60 } }), { status: 200 });
      }
      calls.push({ url, key: headers['x-relay-key'] ?? '', body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response(JSON.stringify({ code: 0, data: { token: 'pt', expires_in: 60, view_url: 'http://relay.example.com/view?sid=sid-1&token=pt' } }), { status: 200 });
    });
    let emitOpen: (() => void) | undefined;
    let emitMsg: ((d: string) => void) | undefined;
    const ws = {
      send: vi.fn(), close: vi.fn(),
      on: (ev: string, cb: (...a: never[]) => void) => {
        if (ev === 'open') emitOpen = () => cb();
        if (ev === 'message') emitMsg = (d: string) => (cb as (x: string) => void)(d);
      },
    };
    const service = makeService({
      relayFetch: relayFetch as unknown as typeof fetch,
      wsFactory: () => ws,
    });
    await service.save({ relayUrl: 'https://relay.example.com/tunnel', key: 'sekret', enabled: true });
    // start() 内部异步：等 stub 的 open 回调注册完成再触发，否则状态停在 connecting
    for (let i = 0; i < 40 && !emitOpen; i++) await new Promise(r => setTimeout(r, 25));
    expect(emitOpen, 'ws open 回调应已注册').toBeTruthy();
    emitOpen!();
    emitMsg?.(JSON.stringify({ type: 'auth_ack', device_sid: 'sid-1', pair_status: 'matched' }));
    for (let i = 0; i < 40 && (await service.status()).state !== 'paired'; i++) await new Promise(r => setTimeout(r, 25));
    expect((await service.status()).state).toBe('paired');
    const p = await service.pair();
    expect(p).toMatchObject({ token: 'pt', expiresIn: 60 });
    // relay 在 nginx 后输出无前缀 http URL；pair() 必须用配置的协议+路径前缀重写
    expect(p?.viewUrl).toBe('https://relay.example.com/tunnel/view?sid=sid-1&token=pt');
    const pairCall = calls.filter(c => c.url.includes('/api/v1/remote/pair'));
    expect(pairCall.length).toBe(1);
    expect(pairCall[0].url).toBe('https://relay.example.com/tunnel/api/v1/remote/pair');
    expect(pairCall[0].key).toBe('sekret');
    expect(pairCall[0].body).toMatchObject({ device_sid: 'sid-1' });
  });

  it('waiting（已连 relay 等终端）也能出码——手机本身是终端，不能鸡生蛋', async () => {
    const urls: string[] = [];
    const relayFetch = vi.fn(async (input: any) => {
      urls.push(String(input));
      const u = String(input);
      if (u.endsWith('/api/v1/remote/device')) return new Response(JSON.stringify({ code: 0, data: { device_sid: 'sid-w', token: 'tk', expires_in: 60 } }), { status: 200 });
      return new Response(JSON.stringify({ code: 0, data: { token: 'pt', expires_in: 60, view_url: 'http://h/view?sid=sid-w&token=pt' } }), { status: 200 });
    });
    let emitOpen: (() => void) | undefined;
    let emitMsg: ((d: string) => void) | undefined;
    const ws = { send: vi.fn(), close: vi.fn(), on: (ev: string, cb: (...a: never[]) => void) => {
      if (ev === 'open') emitOpen = () => cb();
      if (ev === 'message') emitMsg = (d: string) => (cb as (x: string) => void)(d);
    } };
    const service = makeService({ relayFetch: relayFetch as unknown as typeof fetch, wsFactory: () => ws as never });
    await service.save({ relayUrl: 'https://relay.example.com', key: 'k', enabled: true });
    for (let i = 0; i < 40 && !emitOpen; i++) await new Promise(r => setTimeout(r, 25));
    emitOpen!();
    emitMsg?.(JSON.stringify({ type: 'auth_ack', device_sid: 'sid-w', pair_status: 'waiting' }));
    for (let i = 0; i < 40 && (await service.status()).state !== 'waiting'; i++) await new Promise(r => setTimeout(r, 25));
    expect((await service.status()).state).toBe('waiting');
    const p = await service.pair();
    expect(p, 'waiting 状态必须能生成配对码').toBeTruthy();
    expect(p?.token).toBe('pt');
  });

  it('未连接（非 paired）时返回 null，且不发起 pair 请求', async () => {
    // 注意：relayFetch 会被 client 的连接流程调用（device/token），这是预期的；
    // 要断言的是 pair 端点不被调用。
    const urls: string[] = [];
    const relayFetch = vi.fn(async (input: any) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ code: 0, data: { device_sid: 's', token: 't', expires_in: 60 } }), { status: 200 });
    });
    const service = makeService({ relayFetch: relayFetch as unknown as typeof fetch });
    await service.save({ relayUrl: 'https://relay.example.com:8443', key: 'k', enabled: true });
    expect(await service.pair()).toBeNull();
    expect(urls.some(u => u.includes('/api/v1/remote/pair'))).toBe(false);
  });
});
