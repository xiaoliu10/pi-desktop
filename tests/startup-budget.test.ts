import { appendFileSync, mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { PiBackend } from '../src/main/pi/backend';
import { SessionIndex, fileKey } from '../src/main/pi/session-index';
import type { PiEnvironment, PiEvent, PiRun } from '../src/shared/pi';
import type { PiRpcClient } from '../src/main/pi/rpc-client';

const dirs: string[] = [];
const makeDir = () => { const d = mkdtempSync(join(tmpdir(), 'startup-budget-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const env = (): PiEnvironment => ({ executable: '/bin/echo', version: '1.0.0', supported: true, agentDir: '/tmp/agent', sessionDirs: [], diagnostics: [] });

/** 访问私有方法：预算逻辑是纯函数，launch 之外单测直接调。 */
const budget = (b: PiBackend, file: string): number => (b as unknown as { startupBudget(f: string): number }).startupBudget(file);

/** 可控假 RPC 客户端：stateCalls 记录 get_state 次数；setStatus 事件同步回调让 policyReady 置位。 */
function fakeClient(opts: { failStates?: number; hangAfterFirst?: boolean } = {}) {
  let stateCalls = 0;
  const client = {
    stopped: false, stderrTail: '', exitInfo: null as { code: number | null; signal: string | null } | null,
    stderrDetail: () => '', exitDetail: () => '',
    request: async (type: string) => {
      if (type === 'get_state') {
        stateCalls += 1;
        if (stateCalls <= (opts.failStates ?? 0)) throw new Error('get_state 超时；未自动重试，执行状态可能未知。');
        if (opts.hangAfterFirst && stateCalls > 1) await new Promise(() => undefined); // 永不 settle
        return { model: undefined, thinkingLevel: 'off', isStreaming: false, isCompacting: false, messageCount: 5 };
      }
      if (type === 'get_available_models') return { models: [] };
      if (type === 'get_commands') return { commands: [] };
      if (type === 'get_available_thinking_levels') return { levels: [] };
      return {};
    },
    on: (ev: string, cb: (e: unknown) => void) => {
      // 只对 'event' 回调 setStatus（launch 的 policyReady 依赖它）；'closed' 不回调，
      // 否则 launch 的 closed 处理器会立刻删掉 active run，retry 守卫会误判。
      if (ev === 'event') cb({ type: 'extension_ui_request', id: 'x', method: 'setStatus', statusKey: 'desktop-policy', statusText: 'ready' });
      return undefined;
    },
    send: () => undefined, close: () => undefined,
  };
  return { client: client as unknown as PiRpcClient, calls: () => stateCalls };
}

function makeBackend(dir: string) {
  const owned = join(dir, 'sessions', 'desktop');
  mkdirSync(owned, { recursive: true });
  const policy = join(owned, 'policy.mjs');
  writeFileSync(policy, 'export default function () {}\n');
  const index = new SessionIndex([owned], owned);
  const b = new PiBackend(env(), index, owned, policy, () => undefined, dir);
  return { b, owned };
}

/** 造一个指定大小的合法 session 文件（稀疏写，避免真写 40MB）。 */
function bigSession(dir: string, name: string, mb: number): string {
  mkdirSync(dir, { recursive: true });
  const f = join(dir, name);
  writeFileSync(f, JSON.stringify({ type: 'session', version: 3, id: 'big', timestamp: new Date().toISOString(), cwd: dir }) + '\n');
  truncateSync(f, mb * 1_048_576);
  return f;
}

describe('startupBudget', () => {
  it('小会话（<10MB）保持 60s 基线', () => {
    const b = new PiBackend(env(), new SessionIndex([], makeDir()), makeDir(), join(makeDir(), 'p.mjs'), () => undefined);
    const f = join(makeDir(), 'small.jsonl');
    writeFileSync(f, 'x'.repeat(1024));
    expect(budget(b, f)).toBe(60_000);
  });

  it('大会话放宽预算（40MB → 210s，>10MB 起算），超大封顶 300s', () => {
    const b = new PiBackend(env(), new SessionIndex([], makeDir()), makeDir(), join(makeDir(), 'p.mjs'), () => undefined);
    const dir = makeDir();
    const f = bigSession(dir, 'big.jsonl', 40);
    expect(budget(b, f)).toBe(60_000 + (40 - 10) * 5_000); // 210s
    expect(budget(b, bigSession(dir, 'huge.jsonl', 200))).toBe(300_000); // 封顶 5 分钟
  });

  it('文件不存在时退化为 60s（不抛错）', () => {
    const b = new PiBackend(env(), new SessionIndex([], makeDir()), makeDir(), join(makeDir(), 'p.mjs'), () => undefined);
    expect(budget(b, '/nonexistent/session.jsonl')).toBe(60_000);
  });
});

describe('connect 首帧重试', () => {
  it('首帧第一次超时 → 重试成功 → 连接就绪（不判死），get_state 恰好 2 次', async () => {
    const dir = makeDir();
    const { b } = makeBackend(dir);
    const fake = fakeClient({ failStates: 1 });
    b.clientFactory = () => fake.client;
    const result = await b.connect({ cwd: dir, trustProject: false, permission: 'ask' });
    expect(result.status).toBe('idle');
    expect(fake.calls()).toBe(2); // 第一次超时 + 重试成功
  });

  it('大会话（预算放宽）launch 即广播 stage=loading，用户立刻看到加载态', async () => {
    const dir = makeDir();
    const { b, owned } = makeBackend(dir);
    const file = bigSession(owned, 'loading-broadcast.jsonl', 20); // 20MB → 预算 >60s
    const fake = fakeClient();
    b.clientFactory = () => fake.client;
    const stages: (string | undefined)[] = [];
    const origEmit = (b as unknown as { emit: (e: PiEvent) => void }).emit.bind(b);
    (b as unknown as { emit: (e: PiEvent) => void }).emit = (e: PiEvent) => {
      if (e.type === 'run') stages.push((e.run as PiRun).stage);
      origEmit(e);
    };
    await b.connect({ sourceKey: fileKey(file), cwd: dir, trustProject: false, permission: 'ask' });
    expect(stages).toContain('loading');
    expect(stages[stages.length - 1]).toBeUndefined(); // 就绪后清理
  });

  it('等待期内 run 已从 active 移除（断开/崩溃）→ 不重试、不迟到 emit', async () => {
    const dir = makeDir();
    const { b, owned } = makeBackend(dir);
    const file = bigSession(owned, 'closed-mid-wait.jsonl', 20);
    let secondIssued = false;
    const fake = fakeClient({ failStates: 1 });
    const origRequest = fake.client.request.bind(fake.client);
    (fake.client as unknown as { request: unknown }).request = async (type: string) => {
      if (type === 'get_state') {
        if (!secondIssued) { secondIssued = true; throw new Error('get_state 超时；未自动重试，执行状态可能未知。'); }
        secondIssued = false;
        throw new Error('should not be called after close');
      }
      return origRequest(type);
    };
    b.clientFactory = () => fake.client;
    const emitted: PiEvent[] = [];
    (b as unknown as { emit: (e: PiEvent) => void }).emit = (e: PiEvent) => { emitted.push(e); };
    const p = b.connect({ sourceKey: fileKey(file), cwd: dir, trustProject: false, permission: 'ask' }).catch(e => e);
    await Promise.resolve(); // 让 launch 走到第一次 get_state 拒绝点
    b.dispose();
    const outcome = await p;
    expect(outcome).toBeInstanceOf(Error); // 不静默成功
  });

  it('首帧两次都超时：报错文案带规模与重试指引（不是无信息量的进程死亡）', async () => {
    const dir = makeDir();
    const { b, owned } = makeBackend(dir);
    const file = bigSession(owned, 'double-timeout.jsonl', 40);
    b.clientFactory = () => fakeClient({ failStates: 99 }).client;
    const err = await b.connect({ sourceKey: fileKey(file), cwd: dir, trustProject: false, permission: 'ask' }).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).toMatch(/40\.0 MB 历史/);
    expect(String((err as Error).message)).toMatch(/再次点击该会话重试/);
  });

  it('models 拉取阶段超时不贴首帧文案（历史已加载完，不诱导昂贵重连）', async () => {
    const dir = makeDir();
    const { b, owned } = makeBackend(dir);
    const file = bigSession(owned, 'models-timeout.jsonl', 40);
    b.clientFactory = () => ({
      stopped: false, stderrTail: '', exitInfo: null, stderrDetail: () => '', exitDetail: () => '',
      request: async (type: string) => {
        if (type === 'get_state') return { model: undefined, thinkingLevel: 'off', isStreaming: false };
        if (type === 'get_available_models') throw new Error('get_available_models 超时；未自动重试，执行状态可能未知。');
        return {};
      },
      on: (ev: string, cb: (e: unknown) => void) => { if (ev === 'event') cb({ type: 'extension_ui_request', id: 'x', method: 'setStatus', statusKey: 'desktop-policy', statusText: 'ready' }); return undefined; },
      send: () => undefined, close: () => undefined,
    } as unknown as PiRpcClient);
    const err = await b.connect({ sourceKey: fileKey(file), cwd: dir, trustProject: false, permission: 'ask' }).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).not.toMatch(/再次点击该会话重试/);
  });
});
