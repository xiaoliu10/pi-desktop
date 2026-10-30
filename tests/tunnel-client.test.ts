import { describe, expect, it, vi } from 'vitest';
import { TunnelClient } from '../src/main/pi/tunnel-client';

/**
 * tunnel-client 单元行为（方案 D §4.3）。与真 relay 的互通在
 * pi-tunnel-relay 仓库的 Go 测试覆盖；这里钉住桌面侧的契约：
 * - 地址校验：拒绝内嵌凭据（Harness 原则）
 * - handled 状态机：connecting → waiting → paired
 * - 收到 terminal 的 HTTP 请求帧时必须带 Authorization 调本地服务
 * - 未知帧明确回 WRONG_PARAM（不静默）
 */

const okFetch = vi.fn(async () => new Response(JSON.stringify({ code: 0, data: { device_sid: 'sid-1', token: 'tok', expires_in: 60 } }), { status: 200 }));

function makeClient(over: Partial<ConstructorParameters<typeof TunnelClient>[0]> = {}, wsImpl?: any) {
  const defaultWs = () => {
    const listeners: Record<string, Array<(...a: never[]) => void>> = {};
    const w: any = {
      send: (d: string) => { ((w.__sent ??= []) as string[]).push(d); },
      close: vi.fn(),
      on: (ev: string, cb: (...a: never[]) => void) => { (listeners[ev] ??= []).push(cb); },
      __listeners: listeners,
    };
    return w;
  };
  const opts = {
    relayUrl: 'https://relay.example.com:8443',
    key: 'k-test',
    deviceMid: 'mbp',
    localBase: 'http://127.0.0.1:3123',
    localToken: () => 'local-token',
    relayFetch: okFetch as unknown as typeof fetch,
    fetchImpl: okFetch as unknown as typeof fetch,
    wsFactory: wsImpl ?? defaultWs,
    ...over,
  } as ConstructorParameters<typeof TunnelClient>[0];
  return new TunnelClient(opts);
}

describe('tunnel-client (R-remote-02)', () => {
  it('rejects relay urls with embedded credentials', () => {
    expect(() => makeClient({ relayUrl: 'https://user:pass@relay.example.com' })).toThrow(/凭据/);
  });

  it('walks connecting → waiting → paired on auth_ack', async () => {
    let emit: ((ev: string) => void) | undefined;
    let msg: ((data: string) => void) | undefined;
    const ws = {
      send: vi.fn(),
      close: vi.fn(),
      on: (ev: string, cb: (...a: never[]) => void) => {
        if (ev === 'open') emit = () => cb();
        if (ev === 'message') msg = (d: string) => (cb as (x: string) => void)(d);
      },
    };
    const client = makeClient({}, () => ws);
    const states: string[] = [];
    client.on('state', s => states.push(s));
    await client.start();
    emit?.();
    // auth_init 已发
    expect((ws.send as ReturnType<typeof vi.fn>).mock.calls.some(c => String(c[0]).includes('auth_init'))).toBe(true);
    msg?.(JSON.stringify({ type: 'auth_ack', device_sid: 'sid-1', pair_status: 'waiting' }));
    expect(client.state()).toBe('waiting');
    msg?.(JSON.stringify({ type: 'pair_status_ack', terminal_sid: 't1', pair_status: 'matched' }));
    expect(client.state()).toBe('paired');
    expect(states).toContain('waiting');
    expect(states).toContain('paired');
    client.stop();
  });

  it('forwards terminal HTTP requests to the local server with Authorization', async () => {
    let msg: ((data: string) => void) | undefined;
    const sent: string[] = [];
    const localFetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const ws = {
      send: (d: string) => { sent.push(d); },
      close: vi.fn(),
      on: (ev: string, cb: (...a: never[]) => void) => {
        if (ev === 'open') setImmediate(() => cb());
        if (ev === 'message') msg = (d: string) => (cb as (x: string) => void)(d);
      },
    };
    const client = makeClient({ fetchImpl: localFetch as unknown as typeof fetch }, () => ws);
    await client.start();
    await new Promise(r => setTimeout(r, 30)); // 等 open 回调跑完
    msg?.(JSON.stringify({ type: 'auth_ack', device_sid: 'sid-1', pair_status: 'matched' }));
    msg?.(JSON.stringify({
      type: 'data',
      payload: { id: 'req-1', method: 'GET', path: '/api/state' },
    }));
    await new Promise(r => setTimeout(r, 30));
    const call = localFetch.mock.calls[0];
    expect(String(call?.[0])).toContain('/api/state');
    const headers = (call?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer local-token');
    // 回包帧
    const reply = sent.find(s => s.includes('"req-1"'));
    expect(reply).toBeTruthy();
    expect(reply).toContain('"status":200');
  });

  it('answers unknown frames with an explicit WRONG_PARAM (no silent drop)', async () => {
    let msg: ((data: string) => void) | undefined;
    const sent: string[] = [];
    const ws = {
      send: (d: string) => { sent.push(d); },
      close: vi.fn(),
      on: (ev: string, cb: (...a: never[]) => void) => {
        if (ev === 'message') msg = (d: string) => (cb as (x: string) => void)(d);
      },
    };
    const client = makeClient({}, () => ws);
    await client.start();
    await new Promise(r => setTimeout(r, 10)); // 等 open
    msg?.(JSON.stringify({ type: 'totally-unknown' }));
    expect(sent.some(s => s.includes('WRONG_PARAM'))).toBe(true);
    client.stop();
  });
});
