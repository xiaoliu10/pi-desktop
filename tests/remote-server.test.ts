import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { RemoteServer, type RemoteDataProvider, historyWindow, viewerPage } from '../src/main/pi/remote-server';
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
    editResend: vi.fn(),
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

  it('hides archived sessions and hidden projects from /api/state (matches desktop sidebar)', async () => {
    const { status, base } = await start();
    // 手机端项目视图按 cwd 聚合：不过滤归档会话/已移除项目，等于「已归档删除的项目又能展示」。
    (provider as unknown as { archivedSessions: () => string[] }).archivedSessions = () => ['k1'];
    (provider as unknown as { hiddenProjects: () => string[] }).hiddenProjects = () => ['/hidden'];
    const sessions = [
      ...provider.sessions(),
      { key: 'k3', id: '3', path: '/tmp/hidden/x.jsonl', cwd: '/hidden', name: '已移除项目会话', updatedAt: 99, size: 1, warnings: [], owned: false },
    ];
    (provider as unknown as { sessions: () => typeof sessions }).sessions = () => sessions;
    const state = (await (await fetch(`${base}/api/state?token=${status.token}`)).json()) as { sessions: Array<{ key: string }> };
    expect(state.sessions.map((s) => s.key)).toEqual(['k2']); // k1 归档、k3 隐藏项目
  });

  it('degrades to unfiltered state when archive index is corrupt (no 500)', async () => {
    const { status, base } = await start();
    // archive.list() 索引损坏时抛错：远程页无 UI 承接，必须降级为不过滤而非整个 /api/state 变 500。
    (provider as unknown as { archivedSessions: () => string[] }).archivedSessions = () => { throw new Error('归档索引损坏'); };
    const res = await fetch(`${base}/api/state?token=${status.token}`);
    expect(res.status).toBe(200);
    const state = (await res.json()) as { sessions: Array<{ key: string }> };
    expect(state.sessions.map((s) => s.key)).toEqual(['k2', 'k1']); // 降级：不过滤，页面仍可用
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

  it('POST /api/edit validates shape and delegates to editResend', async () => {
    const { status, base } = await start();
    const bad = await postJson(base, '/api/edit', status.token, { key: 'k1', text: '改' });
    expect(bad.status).toBe(400);
    const empty = await postJson(base, '/api/edit', status.token, { key: 'k1', entryId: 'e1', text: '   ' });
    expect(empty.status).toBe(400);
    const unknown = await postJson(base, '/api/edit', status.token, { key: 'nope', entryId: 'e1', text: '改' });
    expect(unknown.status).toBe(404);
    const ok = await postJson(base, '/api/edit', status.token, { key: 'k1', entryId: 'e1', text: '改过的消息' });
    expect(ok.status).toBe(200);
    expect(provider.editResend).toHaveBeenCalledWith('k1', 'e1', '改过的消息');
  });

  it('POST /api/edit surfaces the half-commit prefix verbatim (forked-send-failed)', async () => {
    // 半提交标记必须原样过 HTTP：页面靠前缀区分「fork 前被拒（可重试）」与
    // 「fork 后发送失败（历史已回退，需走恢复路径）」。handlePost 的 catch 若
    // 重写/包裹错误消息，这个区分就断了（reviewer P3-A）。
    provider.editResend = vi.fn(() => { throw new Error('EDIT_RESEND_SEND_FAILED_AFTER_FORK:上游不可用'); });
    const { status, base } = await start();
    const res = await postJson(base, '/api/edit', status.token, { key: 'k1', entryId: 'e1', text: '改' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('EDIT_RESEND_SEND_FAILED_AFTER_FORK:上游不可用');
  });

  it('viewer page carries the mobile edit/zoom affordances', () => {
    const html = viewerPage();
    // UI 缩放：锁定 viewport（maximum-scale + user-scalable=no），composer 16px 防 iOS 聚焦放大
    expect(html).toContain('maximum-scale=1');
    expect(html).toContain('user-scalable=no');
    expect(html).toMatch(/composer textarea[^}]*font-size:16px/);
    // 编辑重发 UI：消息编辑按钮 + 提交路由 /api/edit
    expect(html).toContain('data-edit');
    expect(html).toContain('/api/edit');
    // 乐观发送：上屏先于 POST 成功（conn 文案）
    expect(html).toContain('发送中…');
    // 死卡片修复：respond 失败向桌面端权威对账后才决定撤卡（不盲目撤）
    expect(html).toContain('失败不盲目撤卡');
    // P1 修复：编辑原文从 viewPages 原始条目取，不从展示 DOM 反提
    expect(html).toContain('originalUserText');
    // P2 修复：乐观项按实例 id 撤回
    expect(html).toContain('o.id !== optId');
    // P2-3 修复：fork 后发送失败（半提交）与 fork 前拒绝分流，且明示恢复路径
    expect(html).toContain('EDIT_RESEND_SEND_FAILED_AFTER_FORK');
    expect(html).toContain('已回退到该消息，但发送失败');
    expect(html).toContain('直接发送即可继续');
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
    expect(html).toContain('id="imgInput"');   // 图片选择（移动端发图）
    expect(html).toContain('id="imgChips"');   // 已选图片预览 chips
    expect(html).toContain('desktopVersion');  // 连接行展示桌面版本号
    expect(html).toContain('think-body');       // 思考折叠气泡（流式不再全文铺开）
    expect(html).toContain('展开思考过程');
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

// ---- 可见性与图片上传（server half of fix/mobile-visibility-and-images） ----

describe('RemoteServer visibility & image uploads', () => {
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
  const getState = async (base: string, token: string) =>
    (await (await fetch(`${base}/api/state?token=${token}`)).json()) as {
      desktopVersion?: string | null;
      sessions: Array<{ key: string }>;
      runs: Array<{ key: string }>;
    };
  const hello64 = Buffer.from('hello').toString('base64'); // canonical base64 样例

  it('filters internal sessions and stale/internal runs from /api/state, exposes desktopVersion', async () => {
    const { status, base } = await start();
    (provider as unknown as { archivedSessions: () => string[] }).archivedSessions = () => ['k1'];
    (provider as unknown as { desktopVersion: () => string }).desktopVersion = () => '0.1.18-test';
    const withInternal = [...provider.sessions(),
      { key: 'k-sub', id: '3', path: '/tmp/sub.jsonl', cwd: '/tmp', name: 'subagent 内部会话', updatedAt: 40, size: 1, warnings: [], owned: false, parentSession: '/tmp/a.jsonl' },
      { key: 'k-side', id: '4', path: '/tmp/side.jsonl', cwd: '/tmp', name: '副驾', updatedAt: 41, size: 1, warnings: [], owned: false, sidecarOf: '' },
    ];
    provider.sessions = () => withInternal;
    const staleRuns = [
      { key: 'k1', generation: 'g1', cwd: '/tmp', file: '/tmp/a.jsonl', status: 'idle', models: [], commands: [], pending: 0 }, // 已归档 → 陈旧 run 不重现
      { key: 'k2', generation: 'g2', cwd: '/tmp', file: '/tmp/b.jsonl', status: 'idle', models: [], commands: [], pending: 0 },
      { key: 'k-sub', generation: 'g3', cwd: '/tmp', file: '/tmp/sub.jsonl', status: 'running', models: [], commands: [], pending: 0 }, // 内部会话的 run
      { key: 'k9', generation: 'g4', cwd: '/tmp', file: '/tmp/side2.jsonl', status: 'running', models: [], commands: [], pending: 0, sidecarOf: 'k2' }, // 副驾 run
    ];
    provider.runs = () => staleRuns;
    const state = await getState(base, status.token);
    expect(state.desktopVersion).toBe('0.1.18-test');
    expect(state.sessions.map((s) => s.key)).toEqual(['k2', 'k1'].filter(k => k !== 'k1'));
    expect(state.runs.map((r) => r.key)).toEqual(['k2']);
  });

  it('desktopVersion is null when the provider does not supply it (old servers stay parseable)', async () => {
    const { status, base } = await start();
    const state = await getState(base, status.token);
    expect(state.desktopVersion).toBeNull();
  });

  it('guards /api/history with the same visibility; corrupt archive index degrades to readable', async () => {
    const { status, base } = await start();
    const grab = async (key: string) => (await fetch(`${base}/api/history?session=${key}&token=${status.token}`)).status;
    (provider as unknown as { archivedSessions: () => string[] }).archivedSessions = () => ['k1'];
    (provider as unknown as { hiddenProjects: () => string[] }).hiddenProjects = () => ['/gone'];
    const withGone = [...provider.sessions(), { key: 'k-gone', id: '5', path: '/tmp/g.jsonl', cwd: '/gone', name: '已移除项目', updatedAt: 50, size: 1, warnings: [], owned: false }];
    provider.sessions = () => withGone;
    const liteHistory = (key: string) => (key === 'k1' || key === 'k2'
      ? { session: {}, entries: [], branch: [{ type: 'message', id: 'e1', message: { role: 'user', content: '你好' } }], leaves: [], leafId: null, syncedAt: 0 }
      : null);
    provider.history = liteHistory;
    expect(await grab('k1')).toBe(404); // 已归档：拿到 key 也不能读逐条历史
    expect(await grab('k-gone')).toBe(404); // 已移除项目
    expect(await grab('k2')).toBe(200);
    // 未知会话仍是 404 同形，不泄露存在性。
    expect(await grab('nope')).toBe(404);
    // 归档索引损坏：降级为不过滤（可读），而不是 500。
    (provider as unknown as { archivedSessions: () => string[] }).archivedSessions = () => { throw new Error('归档索引损坏'); };
    expect(await grab('k1')).toBe(200);
  });

  it('filters SSE run/ui/rpc events for hidden/archived/internal records; sessions-changed always passes and refreshes the visibility input', async () => {
    const { status } = await start();
    (provider as unknown as { hiddenProjects: () => string[] }).hiddenProjects = () => ['/hidden'];
    const withHidden = [...provider.sessions(),
      { key: 'k-hid', id: '6', path: '/tmp/h.jsonl', cwd: '/hidden', name: '已移除项目会话', updatedAt: 60, size: 1, warnings: [], owned: false },
      { key: 'k-sub', id: '7', path: '/tmp/s.jsonl', cwd: '/tmp', name: '内部', updatedAt: 61, size: 1, warnings: [], owned: false, parentSession: '/tmp/a.jsonl' },
    ];
    provider.sessions = () => withHidden;
    const runsWithHidden = [...provider.runs(),
      { key: 'k-hid', generation: 'gh', cwd: '/hidden', file: '/tmp/h.jsonl', status: 'running', models: [], commands: [], pending: 0 },
    ];
    provider.runs = () => runsWithHidden;
    const url = `http://127.0.0.1:${status.port}/api/events?token=${status.token}`;
    const controller = new AbortController();
    const res = await fetch(url, { signal: controller.signal, headers: { accept: 'text/event-stream' } });
    const reader = res.body!.getReader();
    const decode = (chunk: ReadableStreamReadResult<Uint8Array>) => new TextDecoder().decode(chunk.value ?? new Uint8Array());
    expect(decode(await reader.read())).toContain('hello');
    const runEvent = (key: string, cwd: string) => ({ type: 'run' as const, run: { key, generation: 'g', cwd, file: '/x.jsonl', status: 'running' as const, models: [], commands: [], pending: 0 } });
    // 已移除项目的 run/ui/rpc 事件一律被滤掉；随后发出的可见事件（k1）先行到达，证明被滤事件没有漏网。
    server.publish(runEvent('k-hid', '/hidden'));
    server.publish({ type: 'ui', key: 'k-hid', generation: 'gh', request: { id: 'req-h', method: 'confirm', title: '审批' } });
    server.publish({ type: 'rpc', key: 'k-sub', generation: 'g', event: { type: 'message_update' } });
    server.publish(runEvent('k1', '/tmp'));
    const marker = decode(await reader.read());
    expect(marker).toContain('"type":"run"');
    expect(marker).toContain('k1');
    expect(marker).not.toContain('k-hid');
    expect(marker).not.toContain('req-h');
    expect(marker).not.toContain('k-sub');
    // 查看器打开期间项目被恢复可见（动态偏好）：sessions-changed 先行（总是转发 + 失效缓存），
    // 之后同一条 run 事件按新口径放行。
    (provider as unknown as { hiddenProjects: () => string[] }).hiddenProjects = () => [];
    server.publish({ type: 'sessions-changed' });
    expect(decode(await reader.read())).toContain('sessions-changed');
    server.publish(runEvent('k-hid', '/hidden'));
    expect(decode(await reader.read())).toContain('k-hid');
    // 反向：会话被归档后，其 ui 事件也不得重现（stop/respond 不受影响，只是不再展示）。
    (provider as unknown as { archivedSessions: () => string[] }).archivedSessions = () => ['k1'];
    server.publish({ type: 'sessions-changed' });
    await reader.read();
    server.publish({ type: 'ui', key: 'k1', generation: 'g1', request: { id: 'req-1', method: 'confirm', title: '审批' } });
    server.publish({ type: 'ui', key: 'k2', generation: 'g2', request: { id: 'req-2', method: 'confirm', title: '审批' } });
    const last = decode(await reader.read());
    expect(last).toContain('req-2');
    expect(last).not.toContain('req-1');
    controller.abort();
  });

  it('forwards image-only and image+text prompts with normalized shape', async () => {
    const { status, base } = await start();
    const ok = await postJson(base, '/api/prompt', status.token, { key: 'k1', images: [{ mimeType: 'image/png', data: hello64 }] });
    expect(ok.status).toBe(200); // 纯图片发送允许不带 text
    expect(provider.prompt).toHaveBeenCalledWith('k1', '', [{ type: 'image', mimeType: 'image/png', data: hello64 }]);
    const withText = await postJson(base, '/api/prompt', status.token, { key: 'k1', text: '看截图', images: [{ type: 'image', mimeType: 'image/jpeg', data: hello64 }] });
    expect(withText.status).toBe(200);
    expect(provider.prompt).toHaveBeenCalledWith('k1', '看截图', [{ type: 'image', mimeType: 'image/jpeg', data: hello64 }]);
  });

  it('rejects invalid image MIME/base64/shape/extra fields/count without dispatching to the backend', async () => {
    const { status, base } = await start();
    const bad: unknown[] = [
      { key: 'k1', text: 'hi', images: [{ type: 'image', mimeType: 'image/bmp', data: hello64 }] }, // MIME 不在白名单
      { key: 'k1', text: 'hi', images: [{ type: 'image', mimeType: 'image/png', data: 'aGVsbG8' }] }, // 缺 padding
      { key: 'k1', text: 'hi', images: [{ type: 'image', mimeType: 'image/png', data: 'AB==' }] }, // 非canonical 尾位
      { key: 'k1', text: 'hi', images: [{ type: 'image', mimeType: 'image/png', data: 'aGVs bG8=' }] }, // 非法字符
      { key: 'k1', text: 'hi', images: [{ type: 'image', mimeType: 'image/png', data: '' }] }, // 空 data
      { key: 'k1', text: 'hi', images: 'nope' }, // 不是数组
      { key: 'k1', text: 'hi', images: [null] },
      { key: 'k1', text: 'hi', images: [{ data: hello64 }] }, // 缺 mimeType
      { key: 'k1', text: 'hi', images: [{ type: 'photo', mimeType: 'image/png', data: hello64 }] }, // type 非法
      { key: 'k1', text: 'hi', images: [{ mimeType: 'image/png', data: hello64, url: 'http://evil/x.png' }] }, // 未知字段（不拉 URL）
      { key: 'k1', text: 'hi', images: [{ mimeType: 'image/png', data: hello64, path: '/etc/passwd' }] }, // 未知字段（不读路径）
      { key: 'k1', text: 'hi', images: Array.from({ length: 11 }, () => ({ mimeType: 'image/png', data: hello64 })) }, // 超数量
    ];
    for (const body of bad) {
      const res = await postJson(base, '/api/prompt', status.token, body);
      expect(res.status).toBe(400);
    }
    expect(provider.prompt).not.toHaveBeenCalled();
  });

  it('enforces the 10MiB total base64 budget and the ~11MiB prompt body cap without dispatch', async () => {
    const { status, base } = await start();
    // 总长超 10MiB（body 仍 <11MiB 软顶，走到图片校验层）。
    const huge = 'A'.repeat(10 * 1024 * 1024 + 4);
    const overTotal = await postJson(base, '/api/prompt', status.token, { key: 'k1', text: 'hi', images: [{ mimeType: 'image/png', data: huge }] });
    expect(overTotal.status).toBe(400);
    expect(((await overTotal.json()) as { error: string }).error).toContain('10 MiB');
    // body 超 11MiB 软顶：读 body 阶段就拒。
    const overBody = await postJson(base, '/api/prompt', status.token, { key: 'k1', text: 'hi', images: [{ mimeType: 'image/png', data: 'A'.repeat(11 * 1024 * 1024) }] });
    expect(overBody.status).toBe(400);
    expect(((await overBody.json()) as { error: string }).error).toContain('请求体过大');
    expect(provider.prompt).not.toHaveBeenCalled();
  }, 30_000);

  it('keeps the 64KiB body cap for text-only prompts and other POST paths', async () => {
    const { status, base } = await start();
    // 无图 >64KiB body 依旧拒绝（既有口径）。
    expect((await postJson(base, '/api/prompt', status.token, { key: 'k1', text: 'x'.repeat(70 * 1024) })).status).toBe(400);
    // 其他 POST 路径不受 11MiB 放宽影响。
    expect((await postJson(base, '/api/stop', status.token, { key: 'k1', pad: 'x'.repeat(70 * 1024) })).status).toBe(400);
    expect(provider.stop).not.toHaveBeenCalled();
    expect(provider.prompt).not.toHaveBeenCalled();
  });

  it('rejects oversized image+text prompts at the 200k char limit and enforces auth before reading bodies', async () => {
    const { status, base } = await start();
    expect((await postJson(base, '/api/prompt', status.token, { key: 'k1', text: 'x'.repeat(200_001), images: [{ mimeType: 'image/png', data: hello64 }] })).status).toBe(400);
    // 未授权的大 body：鉴权先行，不进入读取/校验。
    const noAuth = await fetch(`${base}/api/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'k1', text: 'hi', images: [{ mimeType: 'image/png', data: hello64 }] }) });
    expect(noAuth.status).toBe(401);
    expect(provider.prompt).not.toHaveBeenCalled();
  });
});

// ---- 历史懒加载（fix/mobile-history-lazy-load） ---- //
// /api/history tail 模式：默认最近 50 条 + hasMore + before 游标；?before=N 翻更早一页。
// 可见性守卫在 tail 模式下同样生效；viewerPage emitted script 必须能被 new Function 解析
// （防止 \n 陷阱：模板内 emitted JS 字符串未闭合会 SyntaxError）。

describe('RemoteServer history lazy-load (tail paging)', () => {
  describe('historyWindow (pure paging helper)', () => {
    it('returns the last page by default with hasMore + start cursor', () => {
      expect(historyWindow(120, null)).toEqual({ start: 70, end: 120, hasMore: true });
      expect(historyWindow(120, null)).toEqual({ start: 70, end: 120, hasMore: true });
    });
    it('returns the full short branch with hasMore=false when len <= page', () => {
      expect(historyWindow(0, null)).toEqual({ start: 0, end: 0, hasMore: false });
      expect(historyWindow(30, null)).toEqual({ start: 0, end: 30, hasMore: false });
      expect(historyWindow(50, null)).toEqual({ start: 0, end: 50, hasMore: false });
    });
    it('marks the 50/51 boundary: exactly 50 has no more, 51 starts a second page', () => {
      expect(historyWindow(50, null).hasMore).toBe(false);
      const w = historyWindow(51, null);
      expect(w).toEqual({ start: 1, end: 51, hasMore: true });
    });
    it('pages older entries with before=N: end=clamp(N), start=max(0,end-page)', () => {
      // before=70 → [20,70)
      expect(historyWindow(120, '70')).toEqual({ start: 20, end: 70, hasMore: true });
      // before=20 → [0,20), 没有更早
      expect(historyWindow(120, '20')).toEqual({ start: 0, end: 20, hasMore: false });
      // before=0 → 空页，没有更早
      expect(historyWindow(120, '0')).toEqual({ start: 0, end: 0, hasMore: false });
    });
    it('clamps out-of-range before and treats non-numeric / empty before as default tail', () => {
      // before 超过 len → end=clamp=len → 同默认 tail
      expect(historyWindow(120, '200')).toEqual({ start: 70, end: 120, hasMore: true });
      // before 负数 → end=0 → 空页
      expect(historyWindow(120, '-5')).toEqual({ start: 0, end: 0, hasMore: false });
      // 非数值 → 视作缺省（默认 tail），不当 0 读出空页
      expect(historyWindow(120, 'abc')).toEqual({ start: 70, end: 120, hasMore: true });
      // 空串 → 视作缺省
      expect(historyWindow(120, '')).toEqual({ start: 70, end: 120, hasMore: true });
      // null → 默认 tail
      expect(historyWindow(120, null)).toEqual({ start: 70, end: 120, hasMore: true });
    });
    it('honors a custom page size', () => {
      expect(historyWindow(120, null, 10)).toEqual({ start: 110, end: 120, hasMore: true });
      expect(historyWindow(120, '20', 10)).toEqual({ start: 10, end: 20, hasMore: true });
    });
    it('guards against non-finite / negative len', () => {
      expect(historyWindow(Number.NaN, null)).toEqual({ start: 0, end: 0, hasMore: false });
      expect(historyWindow(-3, null)).toEqual({ start: 0, end: 0, hasMore: false });
    });
  });

  let server: RemoteServer;
  let provider: RemoteDataProvider;

  beforeEach(() => {
    provider = makeProvider();
    server = new RemoteServer(provider);
  });
  afterEach(async () => { await server.stop(); });

  const start = async () => {
    const status = await server.start(0);
    return { status, base: `http://127.0.0.1:${status.port}` };
  };
  // 120 条消息的分支：偶数 user、奇数 assistant，id=e0..e119。
  const bigBranch = () => Array.from({ length: 120 }, (_, i) => ({
    type: 'message' as const, id: 'e' + i, message: { role: i % 2 ? 'assistant' : 'user', content: 'msg-' + i },
  }));
  const bigHistory = (key: string) => (key === 'k1'
    ? ({ session: {}, entries: [], branch: bigBranch(), leaves: [], leafId: null, syncedAt: 0 } as unknown as PiHistory)
    : null);
  const getHistory = async (base: string, token: string, query: string) =>
    (await (await fetch(`${base}/api/history?session=k1&${query}&token=${token}`)).json()) as {
      branch: Array<{ id: string; message: { role: string; content: string } }>;
      hasMore: boolean;
      before: number;
    };

  it('serves only the last 50 entries by default with hasMore + before cursor', async () => {
    const { status, base } = await start();
    provider.history = bigHistory;
    const h = await getHistory(base, status.token, '');
    expect(h.branch).toHaveLength(50);
    expect(h.branch[0].id).toBe('e70');
    expect(h.branch[49].id).toBe('e119');
    expect(h.hasMore).toBe(true);
    expect(h.before).toBe(70); // 本页起始索引 = 取下一页更早历史的游标
  });

  it('pages older entries with ?before and reports the next cursor + hasMore boundary', async () => {
    const { status, base } = await start();
    provider.history = bigHistory;
    const h1 = await getHistory(base, status.token, 'before=70');
    expect(h1.branch).toHaveLength(50); // [20..69]
    expect(h1.branch[0].id).toBe('e20');
    expect(h1.branch[49].id).toBe('e69');
    expect(h1.hasMore).toBe(true);
    expect(h1.before).toBe(20);
    const h2 = await getHistory(base, status.token, 'before=20');
    expect(h2.branch).toHaveLength(20); // [0..19]
    expect(h2.branch[0].id).toBe('e0');
    expect(h2.branch[19].id).toBe('e19');
    expect(h2.hasMore).toBe(false);
    expect(h2.before).toBe(0);
  });

  it('returns hasMore=false for a short branch (<= page) and an empty page for before=0', async () => {
    const { status, base } = await start();
    provider.history = (key) => (key === 'k1'
      ? ({ session: {}, entries: [], branch: bigBranch().slice(0, 50), leaves: [], leafId: null, syncedAt: 0 } as unknown as PiHistory)
      : null);
    const h = await getHistory(base, status.token, '');
    expect(h.branch).toHaveLength(50);
    expect(h.hasMore).toBe(false);
    expect(h.before).toBe(0);
    // before=0 → 空页（index 0 之前没有条目）
    const empty = await getHistory(base, status.token, 'before=0');
    expect(empty.branch).toHaveLength(0);
    expect(empty.hasMore).toBe(false);
    expect(empty.before).toBe(0);
  });

  it('clamps out-of-range / non-numeric before the same as the pure helper', async () => {
    const { status, base } = await start();
    provider.history = bigHistory;
    // before=200 → 同默认 tail
    const over = await getHistory(base, status.token, 'before=200');
    expect(over.branch).toHaveLength(50);
    expect(over.branch[0].id).toBe('e70');
    expect(over.hasMore).toBe(true);
    // before=-5 → 空页
    const neg = await getHistory(base, status.token, 'before=-5');
    expect(neg.branch).toHaveLength(0);
    expect(neg.hasMore).toBe(false);
    // 非数值 → 默认 tail（不当 0 读空页）
    const nan = await getHistory(base, status.token, 'before=abc');
    expect(nan.branch).toHaveLength(50);
    expect(nan.branch[0].id).toBe('e70');
  });

  it('still guards visibility in tail mode: archived / hidden / unknown → 404; corrupt index degrades to readable', async () => {
    const { status, base } = await start();
    provider.history = bigHistory;
    const grab = async (key: string, query: string) =>
      (await fetch(`${base}/api/history?session=${key}&${query}&token=${status.token}`)).status;
    // 归档会话：即使带 before 游标也 404（同形，不泄露存在性）
    (provider as unknown as { archivedSessions: () => string[] }).archivedSessions = () => ['k1'];
    expect(await grab('k1', '')).toBe(404);
    expect(await grab('k1', 'before=70')).toBe(404);
    // 已移除项目
    (provider as unknown as { archivedSessions: () => string[] }).archivedSessions = () => [];
    (provider as unknown as { hiddenProjects: () => string[] }).hiddenProjects = () => ['/tmp'];
    expect(await grab('k1', '')).toBe(404);
    expect(await grab('k1', 'before=70')).toBe(404);
    // 未知会话
    (provider as unknown as { hiddenProjects: () => string[] }).hiddenProjects = () => [];
    expect(await grab('nope', '')).toBe(404);
    expect(await grab('nope', 'before=70')).toBe(404);
    // 可见会话 tail + before 都可读
    expect(await grab('k1', '')).toBe(200);
    expect(await grab('k1', 'before=70')).toBe(200);
    // 归档索引损坏 → 降级为不过滤（可读），而不是 500
    (provider as unknown as { archivedSessions: () => string[] }).archivedSessions = () => { throw new Error('归档索引损坏'); };
    expect(await grab('k1', '')).toBe(200);
    expect(await grab('k1', 'before=70')).toBe(200);
  });
});

describe('viewerPage emitted script (\\n-template守卫)', () => {
  it('parses as a function body — catches emitted JS strings left open by a \\n in the template', () => {
    const html = viewerPage();
    const m = html.match(/<script>([\s\S]*)<\/script>/);
    expect(m).not.toBeNull();
    // new Function 只解析不执行：emitted 脚本里若 \\n 被编译成真换行导致字符串未闭合，
    // 这里会抛 SyntaxError。模板内 emitted JS 字符串的 \\n 转义必须双反斜杠。
    expect(() => new Function(m![1])).not.toThrow();
  });
});
