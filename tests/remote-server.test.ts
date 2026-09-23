import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { RemoteServer, type RemoteDataProvider } from '../src/main/pi/remote-server';
import type { PiHistory } from '../src/shared/pi';

const provider: RemoteDataProvider = {
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
};

describe('RemoteServer (LAN viewer)', () => {
  let server: RemoteServer;

  beforeEach(() => {
    server = new RemoteServer(provider);
  });
  afterEach(async () => {
    await server.stop();
  });

  it('starts on an ephemeral port with a token and LAN urls', async () => {
    const status = await server.start(0);
    expect(status.running).toBe(true);
    expect(status.token).toMatch(/^[0-9a-f]{32}$/);
    expect(status.urls.length).toBeGreaterThan(0);
    expect(status.urls[0]).toContain('/view?token=');
  });

  it('rejects requests without or with a wrong token', async () => {
    const status = await server.start(0);
    const base = `http://127.0.0.1:${status.port}`;
    const ok = await fetch(`${base}/api/state?token=${status.token}`);
    expect(ok.status).toBe(200);
    const missing = await fetch(`${base}/api/state`);
    expect(missing.status).toBe(401);
    const wrong = await fetch(`${base}/api/state?token=${'0'.repeat(32)}`);
    expect(wrong.status).toBe(401);
    const post = await fetch(`${base}/api/state?token=${status.token}`, { method: 'POST' });
    expect(post.status).toBe(401);
  });

  it('serves read-only state and history JSON', async () => {
    const status = await server.start(0);
    const base = `http://127.0.0.1:${status.port}`;
    const state = (await (await fetch(`${base}/api/state?token=${status.token}`)).json()) as {
      sessions: Array<{ key: string }>;
      runs: Array<{ status: string }>;
    };
    expect(state.sessions.map((s) => s.key)).toEqual(['k2', 'k1']); // newest first
    expect(state.runs[0].status).toBe('running');
    const history = (await (await fetch(`${base}/api/history?session=k1&token=${status.token}`)).json()) as {
      branch: unknown[];
    };
    expect(history.branch).toHaveLength(1);
    const missing = await fetch(`${base}/api/history?session=nope&token=${status.token}`);
    expect(missing.status).toBe(404);
  });

  it('serves the viewer page and 404s unknown routes', async () => {
    const status = await server.start(0);
    const base = `http://127.0.0.1:${status.port}`;
    const page = await fetch(`${base}/view?token=${status.token}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('PI Desktop');
    const nope = await fetch(`${base}/whatever?token=${status.token}`);
    expect(nope.status).toBe(404);
  });

  it('publishes events to connected SSE viewers and stops cleanly', async () => {
    const status = await server.start(0);
    const url = `http://127.0.0.1:${status.port}/api/events?token=${status.token}`;
    const controller = new AbortController();
    const res = await fetch(url, { signal: controller.signal, headers: { accept: 'text/event-stream' } });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('hello');
    server.publish({ type: 'sessions-changed' });
    const second = await reader.read();
    expect(new TextDecoder().decode(second.value)).toContain('sessions-changed');
    controller.abort();
    const after = await server.stop();
    expect(after.running).toBe(false);
  });
});
