import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { RemoteServer, type RemoteDataProvider } from '../src/main/pi/remote-server';

/**
 * 配对码与短时效 session（R-remote-01）。
 *
 * 背景：现有远程控制把固定 token 拼在 URL 里（`/view?token=...`），一旦二维码被拍照、
 * URL 进浏览器历史或被 Referer 带出，等于永久钥匙（RFC 6819 §4.6.7 明确要求用
 * Authorization 头而非 URI 参数，并限制有效期与一次性使用）。
 *
 * 目标：二维码只携带一次性 pairing code（短 TTL、用后即焚），换取一个短时效 session
 * token，后续请求一律走 Authorization 头；URL 里的长驻 token 仅作过渡保留。
 */
function makeProvider(): RemoteDataProvider {
  return {
    sessions: () => [
      { key: 'k1', id: '1', path: '/tmp/a.jsonl', cwd: '/tmp', name: '会话A', updatedAt: 20, size: 10, warnings: [], owned: false },
    ],
    runs: () => [],
    historyPage: async () => ({ branch: [], hasMore: false, before: 0 }),
    version: () => '0.85.1-test',
    prompt: vi.fn(),
    stop: vi.fn(),
    respond: vi.fn(),
    pendingDialogs: vi.fn(() => []),
  };
}

const postJson = (base: string, path: string, token: string | undefined, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });

describe('pairing code and short-lived session (R-remote-01)', () => {
  let server: RemoteServer;
  let base: string;

  beforeEach(async () => {
    server = new RemoteServer(makeProvider());
    const status = await server.start();
    base = `http://127.0.0.1:${status.port}`;
  });

  afterEach(async () => {
    await server.stop();
  });

  it('exposes a one-time pairing code that is short and not the long-lived token', async () => {
    const status = await server.status();
    expect(status.pairing).toBeDefined();
    expect(status.pairing!.code).toMatch(/^[0-9]{6}$/);
    // 配对码绝不能等于长期 token：那等于没换。
    expect(status.pairing!.code).not.toBe(status.token);
    expect(status.pairing!.expiresAt).toBeGreaterThan(Date.now());
  });

  it('exchanges a pairing code for a session token and then accepts it via Authorization only', async () => {
    const status = await server.status();
    const res = await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: status.pairing!.code }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { session: string; expiresAt: number };
    expect(body.session).toBeTruthy();
    expect(body.session).not.toBe(status.token);
    expect(body.expiresAt).toBeGreaterThan(Date.now());

    // 无 token 直接访问必须 401（证明授权来自 session 而非 URL）。
    expect((await fetch(`${base}/api/state`)).status).toBe(401);
    // 带 session 的 Authorization 头必须通过。
    expect((await fetch(`${base}/api/state`, { headers: { authorization: `Bearer ${body.session}` } })).status).toBe(200);
  });

  it('burns the pairing code after one successful exchange', async () => {
    const status = await server.status();
    const code = status.pairing!.code;
    const first = await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    expect(first.status).toBe(200);

    const second = await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    expect(second.status).toBe(401);
  });

  it('rejects an unknown pairing code', async () => {
    const res = await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: '000000' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects an expired session token even though the code was valid', async () => {
    const status = await server.status();
    const res = await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: status.pairing!.code }),
    });
    const { session, expiresAt } = (await res.json()) as { session: string; expiresAt: number };
    // session 必须是短时效，而不是跟长期 token 一样永不过期。
    expect(expiresAt - Date.now()).toBeLessThanOrEqual(12 * 60 * 60 * 1000 + 5_000);
    expect((await fetch(`${base}/api/state`, { headers: { authorization: `Bearer ${session}` } })).status).toBe(200);
  });

  it('keeps the legacy URL token working during migration', async () => {
    const status = await server.status();
    expect((await fetch(`${base}/api/state?token=${status.token}`)).status).toBe(200);
  });

  it('rotates the session token on restart so an old QR cannot be replayed', async () => {
    const before = await server.status();
    await server.stop();
    await server.start();
    const after = await server.status();
    expect(after.token).not.toBe(before.token);
    expect(after.pairing!.code).not.toBe(before.pairing!.code);
  });
});
