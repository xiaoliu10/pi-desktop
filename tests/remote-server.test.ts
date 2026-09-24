import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { RemoteServer, type RemoteDataProvider } from '../src/main/pi/remote-server';
import type { PiHistory } from '../src/shared/pi';

function makeProvider(): RemoteDataProvider {
  return {
    sessions: () => [
      { key: 'k1', id: '1', path: '/tmp/a.jsonl', cwd: '/tmp', name: '会话A', updatedAt: 20, size: 10, warnings: [], owned: false },
      { key: 'k2', id: '2', path: '/tmp/b.jsonl', cwd: '/tmp', name: '会话B', updatedAt: 30, size: 10, warnings: [], owned: true },
    ],
    runs: () => [
      { key: 'k1', generation: 'g1', cwd: '/tmp', file: '/tmp/a.jsonl', status: 'running', models: [], pending: 1 },
    ],
    history: (key) =>
      key === 'k1'
        ? ({ session: {}, entries: [], branch: [{ type: 'message', id: 'e1', message: { role: 'user', content: '你好' } }], leaves: [], leafId: null, syncedAt: 0 } as unknown as PiHistory)
        : null,
    version: () => '0.85.1-test',
    prompt: vi.fn(),
    stop: vi.fn(),
    respond: vi.fn(),
    pendingDialogs: vi.fn(() => [
      { generation: 'g1', request: { id: 'req-1', method: 'confirm', title: '允许写文件？', message: 'test.ts' } },
    ]),
  };
}

describe('RemoteServer (LAN remote control)', () => {
  let server: RemoteServer;
  let provider: RemoteDataProvider;

  beforeEach(() => {
    provider = makeProvider();
    server = new RemoteServer(provider);
  });
  afterEach(async () => {
    await server.stop();
  });

  const start = async () => {
    const status = await server.start(0);
    return { status, base: `http://127.0.0.1:${status.port}` };
  };
  const postJson = (base: string, path: string, token: string | undefined, body: unknown) =>
    fetch(`${base}${path}${token === undefined ? '' : `?token=${token}`}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('starts on an ephemeral port with a token and LAN urls', async () => {
    const { status } = await start();
    expect(status.running).toBe(true);
    expect(status.token).toMatch(/^[0-9a-f]{32}$/);
    expect(status.urls.length).toBeGreaterThan(0);
    expect(status.urls[0]).toContain('/view?token=');
  });

  it('rejects requests without or with a wrong token (GET and POST)', async () => {
    const { status, base } = await start();
    expect((await fetch(`${base}/api/state?token=${status.token}`)).status).toBe(200);
    expect((await fetch(`${base}/api/state`)).status).toBe(401);
    expect((await fetch(`${base}/api/state?token=${'0'.repeat(32)}`)).status).toBe(401);
    expect((await postJson(base, '/api/prompt', undefined, { key: 'k1', text: 'hi' })).status).toBe(401);
    expect((await postJson(base, '/api/prompt', '0'.repeat(32), { key: 'k1', text: 'hi' })).status).toBe(401);
    // 未列入白名单的 POST 路径：先过 token 再 404。
    expect((await postJson(base, '/api/state', status.token, {})).status).toBe(404);
    // 其他方法一律 405。
    expect((await fetch(`${base}/api/state?token=${status.token}`, { method: 'DELETE' })).status).toBe(405);
  });

  it('accepts Authorization: Bearer token as an alternative', async () => {
    const { status, base } = await start();
    const res = await fetch(`${base}/api/state`, { headers: { authorization: `Bearer ${status.token}` } });
    expect(res.status).toBe(200);
  });

  it('serves state (with dialogs snapshot) and history JSON', async () => {
    const { status, base } = await start();
    const state = (await (await fetch(`${base}/api/state?token=${status.token}`)).json()) as {
      sessions: Array<{ key: string }>;
      runs: Array<{ status: string; generation: string; dialogs: Array<{ generation: string; request: { id: string; method: string } }> }>;
    };
    expect(state.sessions.map((s) => s.key)).toEqual(['k2', 'k1']); // newest first
    expect(state.runs[0].status).toBe('running');
    expect(state.runs[0].generation).toBe('g1');
    expect(state.runs[0].dialogs).toHaveLength(1);
    expect(state.runs[0].dialogs[0].request.id).toBe('req-1');
    expect(provider.pendingDialogs).toHaveBeenCalledWith('k1');
    const history = (await (await fetch(`${base}/api/history?session=k1&token=${status.token}`)).json()) as { branch: unknown[] };
    expect(history.branch).toHaveLength(1);
    expect((await fetch(`${base}/api/history?session=nope&token=${status.token}`)).status).toBe(404);
  });

  it('POST /api/prompt queues the message through the provider', async () => {
    const { status, base } = await start();
    const res = await postJson(base, '/api/prompt', status.token, { key: 'k1', text: '修个 bug' });
    expect(res.status).toBe(200);
    expect(provider.prompt).toHaveBeenCalledWith('k1', '修个 bug');
    // 空文本 400；未知（未连接）会话 404；超长 400。
    expect((await postJson(base, '/api/prompt', status.token, { key: 'k1', text: '   ' })).status).toBe(400);
    expect((await postJson(base, '/api/prompt', status.token, { key: 'nope', text: 'hi' })).status).toBe(404);
    expect((await postJson(base, '/api/prompt', status.token, { key: 'k1', text: 'x'.repeat(200_001) })).status).toBe(400);
    expect(provider.prompt).toHaveBeenCalledTimes(1);
  });

  it('POST /api/stop delegates to the provider with the same guards', async () => {
    const { status, base } = await start();
    expect((await postJson(base, '/api/stop', status.token, { key: 'k1' })).status).toBe(200);
    expect(provider.stop).toHaveBeenCalledWith('k1');
    expect((await postJson(base, '/api/stop', status.token, { key: 'nope' })).status).toBe(404);
  });

  it('POST /api/respond validates shape and delegates', async () => {
    const { status, base } = await start();
    const ok = await postJson(base, '/api/respond', status.token, {
      key: 'k1', generation: 'g1', response: { id: 'req-1', confirmed: true },
    });
    expect(ok.status).toBe(200);
    expect(provider.respond).toHaveBeenCalledWith('k1', 'g1', { id: 'req-1', confirmed: true });
    // 缺 generation / response 形状非法 / 会话未连接 → 400/404，且不触达 provider。
    expect((await postJson(base, '/api/respond', status.token, { key: 'k1', response: { id: 'r' } })).status).toBe(400);
    expect((await postJson(base, '/api/respond', status.token, { key: 'k1', generation: 'g1', response: { id: 'r' } })).status).toBe(400);
    expect((await postJson(base, '/api/respond', status.token, { key: 'k1', generation: 'g1', response: { id: 'r', value: 42 } })).status).toBe(400);
    expect((await postJson(base, '/api/respond', status.token, { key: 'nope', generation: 'g1', response: { id: 'r', value: 'x' } })).status).toBe(404);
    expect(provider.respond).toHaveBeenCalledTimes(1);
    // provider 抛出的业务错误（如过期）回 400 + 消息。
    (provider.respond as ReturnType<typeof vi.fn>).mockImplementationOnce(() => { throw new Error('交互请求已过期'); });
    const expired = await postJson(base, '/api/respond', status.token, { key: 'k1', generation: 'g1', response: { id: 'r', value: 'x' } });
    expect(expired.status).toBe(400);
    expect(((await expired.json()) as { error: string }).error).toContain('已过期');
  });

  it('rejects oversized request bodies', async () => {
    const { status, base } = await start();
    const res = await postJson(base, '/api/prompt', status.token, { key: 'k1', text: 'x'.repeat(70 * 1024) });
    expect(res.status).toBe(400);
    expect(provider.prompt).not.toHaveBeenCalled();
  });

  it('serves the viewer page with control UI markers', async () => {
    const { status, base } = await start();
    const page = await fetch(`${base}/view?token=${status.token}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('PI Desktop');
    expect(html).toContain('composer');        // 输入框
    expect(html).toContain('stopbtn');         // 停止按钮
    expect(html).toContain('applyDelta');      // 流式打字机
    expect(html).toContain('/api/respond');    // 审批卡片提交
    const nope = await fetch(`${base}/whatever?token=${status.token}`);
    expect(nope.status).toBe(404);
  });

  it('publishes run/ui/rpc events to connected SSE viewers and stops cleanly', async () => {
    const { status } = await start();
    const url = `http://127.0.0.1:${status.port}/api/events?token=${status.token}`;
    const controller = new AbortController();
    const res = await fetch(url, { signal: controller.signal, headers: { accept: 'text/event-stream' } });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('hello');
    server.publish({ type: 'ui', key: 'k1', generation: 'g1', request: { id: 'req-9', method: 'confirm', title: '审批' } });
    const second = await reader.read();
    const frame = new TextDecoder().decode(second.value);
    expect(frame).toContain('"type":"ui"');
    expect(frame).toContain('req-9');
    server.publish({ type: 'rpc', key: 'k1', generation: 'g1', event: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '你好' } } });
    const third = await reader.read();
    expect(new TextDecoder().decode(third.value)).toContain('assistantMessageEvent');
    controller.abort();
    const after = await server.stop();
    expect(after.running).toBe(false);
  });
});
