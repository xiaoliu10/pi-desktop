import { describe, expect, it, vi } from 'vitest';
import { TunnelClient } from '../src/main/pi/tunnel-client';

/**
 * 修复 R-remote-02 的一个 bug：relay 地址带路径（如 https://host/tunnel）时，
 * `new URL(path, base)` 会把 base 的 pathname 丢掉 → 请求发到 /api/... 而非 /tunnel/api/...
 * nginx 反代场景下会得到 405（静态目录不接受 POST）或 404。
 */
describe('tunnel-client relay URL path handling', () => {
  it('preserves the base pathname when building relay API URLs', async () => {
    const calls: string[] = [];
    const relayFetch = vi.fn(async (input: any) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ code: 0, data: { device_sid: 'sid', token: 'tok', expires_in: 60 } }), { status: 200 });
    });
    const client = new TunnelClient({
      relayUrl: 'https://www.huimengwangluo.cn/tunnel',
      key: 'k',
      deviceMid: 'm',
      localBase: 'http://127.0.0.1:1',
      localToken: () => 't',
      relayFetch: relayFetch as unknown as typeof fetch,
      wsFactory: () => ({
        send: () => {},
        close: () => {},
        on: () => {},
      }) as never,
    });
    await client.start();
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0]).toBe('https://www.huimengwangluo.cn/tunnel/api/v1/remote/device');
    client.stop();
  });

  it('still works when relay has no path (bare host)', async () => {
    const calls: string[] = [];
    const relayFetch = vi.fn(async (input: any) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ code: 0, data: { device_sid: 'sid', token: 'tok', expires_in: 60 } }), { status: 200 });
    });
    const client = new TunnelClient({
      relayUrl: 'https://relay.example.com',
      key: 'k',
      deviceMid: 'm',
      localBase: 'http://127.0.0.1:1',
      localToken: () => 't',
      relayFetch: relayFetch as unknown as typeof fetch,
      wsFactory: () => ({ send: () => {}, close: () => {}, on: () => {} }) as never,
    });
    await client.start();
    expect(calls[0]).toBe('https://relay.example.com/api/v1/remote/device');
    client.stop();
  });
});
