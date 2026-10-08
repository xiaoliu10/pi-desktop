import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PiBackend } from '../src/main/pi/backend';
import { SessionIndex, fileKey } from '../src/main/pi/session-index';
import { PiRpcClient } from '../src/main/pi/rpc-client';
import type { PiEnvironment } from '../src/shared/pi';

const dirs: string[] = [], backends: PiBackend[] = [], clients: PiRpcClient[] = [];
afterEach(() => {
  backends.splice(0).forEach(b => b.dispose());
  clients.splice(0).forEach(c => c.close());
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const env = (): PiEnvironment => ({ executable: path.resolve('tests/fixtures/fake-pi.mjs'), version: '0.85.1', supported: true, agentDir: '/tmp/agent', sessionDirs: [], diagnostics: [] });

/** 指定大小的合法会话文件（truncate 稀疏写，不真落 MB 级内容）。 */
function bigSession(dir: string, name: string, mb: number): string {
  const f = path.join(dir, name);
  fs.writeFileSync(f, JSON.stringify({ type: 'session', version: 3, id: 'big', timestamp: new Date().toISOString(), cwd: dir }) + '\n');
  fs.truncateSync(f, mb * 1024 * 1024);
  return f;
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-large-stats-')); dirs.push(root);
  const owned = path.join(root, 'desktop'); fs.mkdirSync(owned, { recursive: true });
  const index = new SessionIndex([root, owned], owned);
  const backend = new PiBackend(env(), index, owned, path.resolve('extensions/desktop-policy/index.mjs'), () => undefined);
  backends.push(backend);
  const requests: string[] = [];
  backend.clientFactory = (cmd, args, cwd, e) => {
    const c = new PiRpcClient(cmd, args, cwd, e); clients.push(c);
    vi.spyOn(c, 'request').mockImplementation(((type: string, data: Record<string, unknown>, timeout: number) => { requests.push(type); return PiRpcClient.prototype.request.call(c, type, data, timeout); }) as typeof c.request);
    return c;
  };
  return { root, owned, backend, requests };
}

describe('大会话跳过全量历史明细（不为可选统计冒 RPC 帧超限风险）', () => {
  it('≥8MiB 会话：不发 get_messages，stats/contextUsage 照常，breakdown 明确为空、cacheHitRate 如实', async () => {
    const { root, owned, backend, requests } = setup();
    const file = bigSession(owned, 'big.jsonl', 9);
    const run = await backend.connect({ sourceKey: fileKey(file), cwd: root, trustProject: false, permission: 'ask' });
    await vi.waitFor(() => expect(backend.runs()[0].contextDetails).toBeDefined());
    expect(requests).toContain('get_session_stats');
    expect(requests).not.toContain('get_messages');
    const view = backend.runs()[0];
    expect(view.status).toBe('idle'); // 会话存活，没有被统计请求杀掉
    expect(view.contextUsage).toEqual({ tokens: 1200, contextWindow: 200000, percent: 1 });
    expect(view.stats?.tokens.total).toBe(3200); // 会话统计仍然可用
    expect(view.contextDetails).toEqual({ breakdown: [], method: 'skipped-large-session', cacheHitRate: 1000 / 3000 * 100, fetchedAt: expect.any(Number) });
    expect(backend.runs()).toHaveLength(1);
    void run;
  });

  it('已有旧 breakdown 的大会话：刷新时替换为明确空明细（不保留不可信旧值）', async () => {
    const { root, owned, backend } = setup();
    const file = bigSession(owned, 'big.jsonl', 9);
    const run = await backend.connect({ sourceKey: fileKey(file), cwd: root, trustProject: false, permission: 'ask' });
    await vi.waitFor(() => expect(backend.runs()[0].contextDetails).toBeDefined());
    const internals = backend as unknown as { active: Map<string, { view: typeof run; refreshContextUsage(r: unknown): void }>; refreshContextUsage(r: unknown): void };
    const live = internals.active.get(run.key)!;
    live.view.contextDetails = { breakdown: [{ category: 'messages', chars: 999 }], method: 'active-transcript-chars', cacheHitRate: 7, fetchedAt: 1 };
    internals.refreshContextUsage(live);
    await vi.waitFor(() => expect(backend.runs()[0].contextDetails?.method).toBe('skipped-large-session'));
    expect(backend.runs()[0].contextDetails?.breakdown).toEqual([]);
    expect(backend.runs()[0].contextDetails?.cacheHitRate).toBeCloseTo(1000 / 3000 * 100, 5);
  });

  it('阈值边界：<8MiB 仍拉取明细（active-transcript-chars），≥8MiB 跳过', async () => {
    const small = setup();
    const file = bigSession(small.owned, 'small.jsonl', 7);
    await small.backend.connect({ sourceKey: fileKey(file), cwd: small.root, trustProject: false, permission: 'ask' });
    await vi.waitFor(() => expect(small.backend.runs()[0].contextDetails?.method).toBe('active-transcript-chars'));
    expect(small.requests).toContain('get_messages');
    expect(small.backend.runs()[0].contextDetails?.breakdown.length).toBeGreaterThan(0);
  });
});
