import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IndexWorkerClient } from '../src/main/pi/index-client';
import { IndexUnavailableError } from '../src/main/pi/index-port';
import type { IndexTransport } from '../src/main/pi/index-transport';
import { createIndexWorkerRuntime, type IndexWorkerHandle } from '../src/main/pi/index-worker-entry';
import type { WorkerConfig, WorkerEvent, WorkerReply, WorkerRequest } from '../src/main/pi/index-worker-protocol';
import type { PiEntry, PiSession } from '../src/shared/pi';
import { SessionIndex, fileKey } from '../src/main/pi/session-index';

/** 纯脚本化 transport：不跑真实 runtime，用于精确控制应答时序/错误/退出。 */
class ScriptedTransport implements IndexTransport {
  readonly sent: WorkerRequest[] = [];
  private messageListeners: ((m: unknown) => void)[] = [];
  private exitListeners: ((code: number | null, reason?: string) => void)[] = [];
  terminated = false;
  /** 收到请求时的脚本；默认不答应（用于制造挂起请求）。 */
  onRequest: ((req: WorkerRequest) => void) | undefined;

  emit(message: WorkerEvent | WorkerReply): void {
    for (const l of this.messageListeners) l(message);
  }
  exit(code: number | null, reason?: string): void {
    for (const l of this.exitListeners) l(code, reason);
  }
  post(message: unknown): void {
    const req = message as WorkerRequest;
    this.sent.push(req);
    this.onRequest?.(req);
  }
  onMessage(listener: (m: unknown) => void): void { this.messageListeners.push(listener); }
  onExit(listener: (code: number | null, reason?: string) => void): void { this.exitListeners.push(listener); }
  terminate(): void { this.terminated = true; }
}

/** 把 IndexWorkerClient 与真实 worker runtime（SessionIndex/OutlineCache/RendererHistory）
 *  用内存回调对接：等价 utility process 双工通道，但全部在同一进程。spawn 期间的事件
 *  （sessions/ready）必须缓冲，模拟真实 transport 在 onMessage 注册前 child 已发消息。 */
function inMemoryPair(config: WorkerConfig) {
  const queued: unknown[] = [];
  const listeners: ((m: unknown) => void)[] = [];
  const exitListeners: ((code: number | null, reason?: string) => void)[] = [];
  let runtime: IndexWorkerHandle | undefined;
  let terminated = false;
  const emit = (m: unknown) => {
    if (listeners.length) for (const l of listeners) l(m);
    else queued.push(m);
  };
  const spawn = (): IndexTransport => ({
    post(message) {
      if (terminated) return;
      const req = message as WorkerRequest;
      if (req.op === 'shutdown') {
        emit({ id: req.id, ok: true, value: true });
        runtime?.dispose();
        terminated = true;
        for (const l of exitListeners) l(0, 'shutdown');
        return;
      }
      try {
        const out = runtime!.handle(req);
        const reply = (value: unknown) => emit({ id: req.id, ok: true, value });
        const fail = (error: unknown) => {
          const err = error as { message?: string; code?: string; name?: string } | undefined;
          emit({ id: req.id, ok: false, error: { message: err?.message ?? String(error), ...(err?.code ? { code: err.code } : err?.name ? { code: err.name } : {}) } });
        };
        if (out && typeof (out as Promise<unknown>).then === 'function') void (out as Promise<unknown>).then(reply, fail);
        else reply(out);
      } catch (error) {
        const err = error as { message?: string };
        emit({ id: req.id, ok: false, error: { message: err?.message ?? String(error) } });
      }
    },
    onMessage(l) {
      listeners.push(l);
      if (queued.length) for (const m of queued.splice(0)) queueMicrotask(() => l(m));
    },
    onExit(l) { exitListeners.push(l); },
    terminate() {
      if (terminated) return;
      terminated = true;
      runtime?.dispose();
      for (const l of exitListeners) l(1, 'terminated');
    },
  });
  // runtime 在 spawn 调用瞬间创建（与 client.ready() 时序一致）。
  const wrapped = (cfg: WorkerConfig): IndexTransport => {
    runtime = createIndexWorkerRuntime(cfg, emit);
    return spawn();
  };
  const client = new IndexWorkerClient(config, wrapped);
  return { client, getRuntime: () => runtime };
}

const mkSession = (key: string, extra: Partial<PiSession> = {}): PiSession => ({
  key, id: key, path: `/tmp/${key}.jsonl`, cwd: '/tmp', name: key, updatedAt: 1, size: 1, warnings: [], owned: false, ...extra,
});
const mkEntry = (id: string, parentId?: string): PiEntry => ({ type: 'message', id, ...(parentId ? { parentId } : {}), timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: id } } as PiEntry);

/** 重启用例共用：subscribe 先推一个带代际标记的尾窗再应答（避免 client 进入轮询等待），
 *  这样每个 transport 世代推的 tail 可区分，能证明重启后镜像来自新 worker。 */
let subscribeGeneration = 0;
function wireSubscribe(t: ScriptedTransport): void {
  t.onRequest = req => {
    if (req.op === 'subscribe') {
      const gen = subscribeGeneration++;
      t.emit({ ev: 'tail', key: req.key, tail: [mkEntry('gen' + gen)], total: 1 });
      queueMicrotask(() => t.emit({ id: req.id, ok: true, value: true }));
    } else if (req.op === 'unsubscribe' || req.op === 'shutdown') {
      queueMicrotask(() => t.emit({ id: req.id, ok: true, value: true }));
    }
  };
}

describe('IndexWorkerClient (scripted transport)', () => {
  let transport: ScriptedTransport;
  let client: IndexWorkerClient;
  beforeEach(() => {
    transport = new ScriptedTransport();
    client = new IndexWorkerClient({ roots: [], ownedRoot: '/tmp/owned', agentDir: '/tmp/agent', outlineCachePath: '/tmp/oc.json' }, () => transport);
  });
  afterEach(() => { try { client.close(); } catch { /* noop */ } });

  it('mirrors session metadata for synchronous reads once sessions + ready arrive', async () => {
    // ready 之前同步读为空镜像（不抛、不触盘）。
    expect(client.scan()).toEqual([]);
    const ready = client.ready();
    transport.emit({ ev: 'sessions', sessions: [mkSession('side', { sidecarOf: 'main' }), mkSession('main')] });
    transport.emit({ ev: 'ready' });
    await ready;
    // 元数据镜像是同步读；includeSidecars 过滤与 SessionIndex 同口径。
    expect(client.scan().map(s => s.key)).toEqual(['main']);
    expect(client.scan(true).map(s => s.key)).toEqual(['side', 'main']);
    expect(client.sessionsView(true).map(s => s.key)).toEqual(['side', 'main']);
    expect(client.sessionMeta('main')?.path).toBe('/tmp/main.jsonl');
    expect(client.sessionMeta('nope')).toBeUndefined();
  });

  it('branchTail throws IndexUnavailableError for a key with no mirrored window', async () => {
    const ready = client.ready();
    transport.emit({ ev: 'sessions', sessions: [mkSession('k1')] });
    transport.emit({ ev: 'ready' });
    await ready;
    // 未订阅：绝不返回静默截断的空数组，必须 fail-closed。
    expect(() => client.branchTail('k1', 8)).toThrow(IndexUnavailableError);
    expect(() => client.branchTail('nope', 8)).toThrow(IndexUnavailableError);
  });

  it('fills branchTail from tail events after subscribe; refcounts subscribe/unsubscribe', async () => {
    const ready = client.ready();
    transport.emit({ ev: 'sessions', sessions: [mkSession('k1')] });
    transport.emit({ ev: 'ready' });
    await ready;
    // worker 约定：先推 tail 事件再回 subscribe 应答（通道保序）。
    transport.onRequest = req => {
      if (req.op === 'subscribe') {
        transport.emit({ ev: 'tail', key: req.key, tail: [mkEntry('a'), mkEntry('b'), mkEntry('c')], total: 3 });
        queueMicrotask(() => transport.emit({ id: req.id, ok: true, value: true }));
      }
    };
    await client.subscribe('k1');
    expect(client.branchTail('k1', 2).map(e => e.id)).toEqual(['b', 'c']);
    // n 超出窗口：给全量副本，不补造数据。
    const all = client.branchTail('k1', 64);
    expect(all.map(e => e.id)).toEqual(['a', 'b', 'c']);
    // 返回的是副本，调用方改不到镜像。
    all.reverse();
    expect(client.branchTail('k1', 64).map(e => e.id)).toEqual(['a', 'b', 'c']);
    // 重复订阅只发一次 subscribe。
    await client.subscribe('k1');
    expect(transport.sent.filter(r => r.op === 'subscribe')).toHaveLength(1);
    // 引用计数：第一次 unsubscribe 不通知 worker、不清镜像；第二次才通知。
    client.unsubscribe('k1');
    expect(client.branchTail('k1', 1).map(e => e.id)).toEqual(['c']);
    expect(transport.sent.some(r => r.op === 'unsubscribe')).toBe(false);
    client.unsubscribe('k1');
    expect(transport.sent.some(r => r.op === 'unsubscribe')).toBe(true);
    expect(() => client.branchTail('k1', 1)).toThrow(IndexUnavailableError);
  });

  it('pairs RPC replies by id (out-of-order) and maps error replies onto Errors', async () => {
    const ready = client.ready();
    transport.emit({ ev: 'sessions', sessions: [] });
    transport.emit({ ev: 'ready' });
    await ready;
    const first = client.searchAsync('k1', 'one');
    const second = client.searchAsync('k1', 'two');
    const reqs = transport.sent.filter(r => r.op === 'search');
    expect(reqs).toHaveLength(2);
    expect(new Set(reqs.map(r => r.id))).toHaveLength(2);
    // 乱序应答：第二个请求先回。
    transport.emit({ id: reqs[1]!.id, ok: true, value: { total: 2, hits: [{ entryId: 'x' }] } });
    transport.emit({ id: reqs[0]!.id, ok: false, error: { message: 'boom', code: 'EBAD' } });
    await expect(second).resolves.toMatchObject({ total: 2 });
    await expect(first).rejects.toMatchObject({ message: 'boom', code: 'EBAD' });
    // 迟到/未知 id 的应答被忽略，不污染状态。
    transport.emit({ id: 999_999, ok: true, value: { total: 1, hits: [] } });
    expect(transport.sent.filter(r => r.op === 'search')).toHaveLength(2);
  });

  it('意外退出：挂起请求被拒、分支镜像立刻失效（绝不返回冻结的旧分支）', async () => {
    const ready = client.ready();
    transport.emit({ ev: 'sessions', sessions: [mkSession('k1')] });
    transport.emit({ ev: 'tail', key: 'k1', tail: [mkEntry('a')], total: 1 });
    transport.emit({ ev: 'ready' });
    await ready;
    expect(client.branchTail('k1', 1)).toHaveLength(1);
    const hanging = client.outlineAsync('k1'); // 永不应答
    await Promise.resolve();
    transport.exit(1, 'crashed');
    await expect(hanging).rejects.toThrow(/退出/);
    // 重启窗口内同步读必须 fail-closed：不能把崩溃前的分支当成现状继续用。
    expect(() => client.branchTail('k1', 1)).toThrow(IndexUnavailableError);
    // 元数据列表保留到新快照原子替换（侧栏不闪空），但不再是可信的分支来源。
    expect(client.scan().map(s => s.key)).toEqual(['k1']);
    client.close();
  });

  it('意外退出后有界重启：新 transport 拉起、订阅恢复、新 tail 生效、ready() 重新可用', async () => {
    vi.useFakeTimers();
    try {
      subscribeGeneration = 0;
      const spawned: ScriptedTransport[] = [];
      const restartClient = new IndexWorkerClient(
        { roots: [], ownedRoot: '/tmp/owned', agentDir: '/tmp/agent', outlineCachePath: '/tmp/oc.json' },
        () => { const t = new ScriptedTransport(); wireSubscribe(t); spawned.push(t); return t; },
      );
      const boot = async (t: ScriptedTransport) => {
        t.emit({ ev: 'sessions', sessions: [mkSession('k1')] });
        t.emit({ ev: 'ready' });
      };
      const first = restartClient.ready();
      await boot(spawned[0]!);
      await first;
      await restartClient.subscribe('k1');
      expect(restartClient.branchTail('k1', 1).map(e => e.id)).toEqual(['gen0']);

      spawned[0]!.exit(1, 'crashed');
      expect(() => restartClient.branchTail('k1', 1)).toThrow(IndexUnavailableError);

      // 200ms 退避后拉起第二个 transport
      await vi.advanceTimersByTimeAsync(200);
      expect(spawned).toHaveLength(2);
      const secondReady = restartClient.ready();
      await boot(spawned[1]!);
      await secondReady;
      // 重启后仍被订阅的 key 必须自动重新订阅，且新的尾窗可读
      expect(spawned[1]!.sent.some(r => r.op === 'subscribe' && r.key === 'k1')).toBe(true);
      expect(restartClient.branchTail('k1', 1).map(e => e.id)).toEqual(['gen1']);
      // 重启成功后请求恢复正常
      spawned[1]!.onRequest = req => { if (req.op === 'search') queueMicrotask(() => spawned[1]!.emit({ id: req.id, ok: true, value: { total: 7, hits: [] } })); };
      await expect(restartClient.searchAsync('k1', 'x')).resolves.toMatchObject({ total: 7 });
      restartClient.close();
    } finally { vi.useRealTimers(); }
  });

  it('重启次数耗尽后置 fatal：不再重启、后续请求明确拒绝、ready() 不永久挂起', async () => {
    vi.useFakeTimers();
    try {
      const spawned: ScriptedTransport[] = [];
      const restartClient = new IndexWorkerClient(
        { roots: [], ownedRoot: '/tmp/owned', agentDir: '/tmp/agent', outlineCachePath: '/tmp/oc.json' },
        () => { const t = new ScriptedTransport(); wireSubscribe(t); spawned.push(t); return t; },
      );
      const first = restartClient.ready();
      spawned[0]!.emit({ ev: 'sessions', sessions: [] });
      spawned[0]!.emit({ ev: 'ready' });
      await first;
      // 连续崩溃：200ms / 1s / 3s 三次退避重启，第四次退出即放弃
      for (const delay of [200, 1_000, 3_000]) {
        spawned[spawned.length - 1]!.exit(1, 'crashed');
        await vi.advanceTimersByTimeAsync(delay);
      }
      expect(spawned).toHaveLength(4); // 首次 + 3 次重启
      spawned[3]!.exit(1, 'crashed');
      await vi.advanceTimersByTimeAsync(10_000);
      expect(spawned).toHaveLength(4); // 不再重启
      await expect(restartClient.searchAsync('k1', 'x')).rejects.toThrow(/停止重试|重启失败/);
      await expect(restartClient.ready()).resolves.toBeUndefined();
      restartClient.close();
    } finally { vi.useRealTimers(); }
  });

  it('主动 close() 不触发重启', async () => {
    vi.useFakeTimers();
    try {
      const spawned: ScriptedTransport[] = [];
      const restartClient = new IndexWorkerClient(
        { roots: [], ownedRoot: '/tmp/owned', agentDir: '/tmp/agent', outlineCachePath: '/tmp/oc.json' },
        () => { const t = new ScriptedTransport(); wireSubscribe(t); spawned.push(t); return t; },
      );
      const first = restartClient.ready();
      spawned[0]!.emit({ ev: 'sessions', sessions: [] });
      spawned[0]!.emit({ ev: 'ready' });
      await first;
      restartClient.close();
      spawned[0]!.exit(0, 'shutdown');
      await vi.advanceTimersByTimeAsync(10_000);
      expect(spawned).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  it('close() shuts the worker down, terminates transport and fails pending calls', async () => {
    const ready = client.ready();
    transport.emit({ ev: 'sessions', sessions: [mkSession('k1')] });
    transport.emit({ ev: 'tail', key: 'k1', tail: [mkEntry('a')], total: 1 });
    transport.emit({ ev: 'ready' });
    await ready;
    const hanging = client.outlineAsync('k1');
    const hangingAssertion = expect(hanging).rejects.toThrow();
    // 真实 worker：收到 shutdown → dispose 后自行退出。脚本化模拟该退出，验证 close
    // 不是立即 kill（给 flushNow 留时间），且退出后 transport 被 terminate。
    transport.onRequest = req => { if (req.op === 'shutdown') queueMicrotask(() => transport.exit(0, 'shutdown')); };
    client.close();
    expect(transport.sent.some(r => r.op === 'shutdown')).toBe(true);
    await new Promise(r => setTimeout(r, 0));
    expect(transport.terminated).toBe(true);
    await hangingAssertion;
    expect(() => client.branchTail('k1', 1)).toThrow(IndexUnavailableError);
  });
});

describe('IndexWorkerClient ↔ real worker runtime (in-memory duplex)', () => {
  let dir: string;
  let file: string;
  let key: string;
  let pair: ReturnType<typeof inMemoryPair>;

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'iwc-contract-')));
    const owned = path.join(dir, 'desktop');
    fs.mkdirSync(owned, { recursive: true });
    file = path.join(owned, 'main.jsonl');
    const entries = [
      JSON.stringify({ type: 'session', version: 3, id: 'main-id', cwd: dir }),
      ...[1, 2, 3, 4, 5].map(i => JSON.stringify(mkEntry('m' + i, i === 1 ? undefined : 'm' + (i - 1)))),
      '',
    ].join('\n');
    fs.writeFileSync(file, entries);
    const index = new SessionIndex([owned], owned);
    index.scan();
    key = fileKey(file);
    index.close();
    pair = inMemoryPair({ roots: [owned], ownedRoot: owned, agentDir: path.join(dir, 'agent'), outlineCachePath: path.join(dir, 'oc.json') });
  });
  afterEach(() => { try { pair.client.close(); } catch { /* noop */ } fs.rmSync(dir, { recursive: true, force: true }); });

  it('serves the same flow the Electron main process uses: meta mirror → subscribe → tail → async RPCs', async () => {
    await pair.client.ready();
    // 元数据来自 worker 首个快照，同步可读。
    expect(pair.client.scan().map(s => s.key)).toContain(key);
    expect(pair.client.sessionMeta(key)?.name).toBeDefined();
    // 订阅前尾窗不可用（fail-closed），订阅后 worker 推送分支尖端。
    expect(() => pair.client.branchTail(key, 2)).toThrow(IndexUnavailableError);
    await pair.client.subscribe(key);
    expect(pair.client.branchTail(key, 2).map(e => e.id)).toEqual(['m4', 'm5']);
    // 异步 RPC 经 id 配对拿到 worker 内真实计算结果（有界/投影后）。
    const history = await pair.client.historyAsync(key);
    expect(history.branch.map(e => e.id)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
    const found = await pair.client.searchAsync(key, 'm3');
    expect(found.hits.some(h => h.entryId === 'm3')).toBe(true);
    const outline = await pair.client.outlineAsync(key);
    expect(outline.turns.length).toBeGreaterThan(0);
    const page = await pair.client.remotePage(key, null, 2);
    expect(page).toMatchObject({ hasMore: true, before: 3 });
    expect(page!.branch.map(e => e.id)).toEqual(['m4', 'm5']);
    expect(await pair.client.remotePage('missing-key', null, 2)).toBeNull();
  });

  it('keeps the mirrored tail fresh after append (changed → pushSessions)', async () => {
    await pair.client.ready();
    await pair.client.subscribe(key);
    expect(pair.client.branchTail(key, 8).map(e => e.id)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
    // 模拟 pi 追加新消息：worker 的 watch/轮询下一拍 changed 前，直接驱动 runtime 的
    // 索引更新与推送（生产中由 SessionIndex.start 的 changed 回调做同一件事）。
    fs.appendFileSync(file, JSON.stringify(mkEntry('m6', 'm5')) + '\n');
    const runtime = pair.getRuntime()!;
    runtime.index.scan();
    // 退订（清镜像）再重订：worker 对 subscribe 一律重推当前 tail，必须含 m6。
    pair.client.unsubscribe(key);
    await pair.client.subscribe(key);
    expect(pair.client.branchTail(key, 4).map(e => e.id)).toEqual(['m3', 'm4', 'm5', 'm6']);
  });
});

describe('SessionIndex implements the same IndexPort contract (owner-side, in-process)', () => {
  let dir: string;
  let file: string;
  let key: string;
  let index: SessionIndex;

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'si-contract-')));
    const owned = path.join(dir, 'desktop');
    fs.mkdirSync(owned, { recursive: true });
    file = path.join(owned, 'main.jsonl');
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'session', version: 3, id: 'main-id', cwd: dir }),
      ...[1, 2, 3].map(i => JSON.stringify(mkEntry('m' + i, i === 1 ? undefined : 'm' + (i - 1)))),
      '',
    ].join('\n'));
    index = new SessionIndex([owned], owned);
    index.scan();
    key = fileKey(file);
  });
  afterEach(() => { index.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('sessionMeta/branchTail bounds: miss throws, n beyond length returns all, n=0 empty', () => {
    expect(index.sessionMeta(key)?.id).toBe('main-id');
    expect(index.sessionMeta('unknown')).toBeUndefined();
    expect(index.branchTail(key, 2).map(e => e.id)).toEqual(['m2', 'm3']);
    expect(index.branchTail(key, 99).map(e => e.id)).toEqual(['m1', 'm2', 'm3']);
    expect(index.branchTail(key, 0)).toEqual([]);
    expect(() => index.branchTail('unknown', 8)).toThrow(); // 不可读 fail-closed（消息文案同 fromCache）
  });

  it('reads fresh values after subscribe (no-op in-process) and after append', async () => {
    // 进程内 subscribe 为空操作，但契约一致：先订阅后取值必须成立。
    await expect(index.subscribe(key)).resolves.toBeUndefined();
    expect(index.branchTail(key, 1).map(e => e.id)).toEqual(['m3']);
    fs.appendFileSync(file, JSON.stringify(mkEntry('m4', 'm3')) + '\n');
    // owner 侧 branchTail 与旧 history() 同口径：增量消费文件尾部，取得到新值。
    expect(index.branchTail(key, 2).map(e => e.id)).toEqual(['m3', 'm4']);
    index.unsubscribe(key); // 不抛即可
  });

  it('remotePage pages with historyWindow and returns null for an unreadable key', async () => {
    await expect(index.remotePage(key, null, 2)).resolves.toMatchObject({ hasMore: true, before: 1 });
    await expect(index.remotePage(key, '0', 2)).resolves.toMatchObject({ branch: [], hasMore: false, before: 0 });
    await expect(index.remotePage('missing', null, 50)).resolves.toBeNull();
  });
});
