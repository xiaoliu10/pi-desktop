import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { usePiStore } from '../src/renderer/pi/adapter';
import { PiBackend } from '../src/main/pi/backend';
import { PiRpcClient } from '../src/main/pi/rpc-client';
import { SessionIndex } from '../src/main/pi/session-index';
import type { PiHistory, PiRun } from '../src/shared/pi';

/**
 * 斜杠扩展命令的 disposition='handled' 收场（plan-mode「只有计时器没有过程」根因）：
 * pi 对 / 开头的输入先执行扩展命令（/plan 是无参 toggle）并把全部参数吞掉——不产生
 * 任何 run/事件。UI 若不按 disposition 收场，乐观气泡 + 计时器永远挂着。
 */

const run: PiRun = { key: 'slash-test', generation: 'gen', cwd: '/mock', file: '/mock/session', status: 'idle', models: [], commands: [], pending: 0 };
const deferred = <T = void>() => { let resolve!: (v: T) => void; let reject!: (e: Error) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
let emit: (e: any) => void;
let api: any;

beforeAll(() => {
  vi.useFakeTimers();
  api = { settingsSnapshot: vi.fn().mockRejectedValue('mock'), environment: vi.fn().mockRejectedValue('mock'), sessions: vi.fn().mockResolvedValue([]), runs: vi.fn().mockResolvedValue([]), archivedSessions: vi.fn().mockResolvedValue([]), onEvent: (fn: typeof emit) => { emit = fn; }, prompt: vi.fn(), history: vi.fn() };
  vi.stubGlobal('window', { localPi: api });
  usePiStore.getState().init();
});
beforeEach(async () => {
  await vi.advanceTimersByTimeAsync(500);
  api.prompt.mockReset(); api.history.mockReset();
  api.history.mockRejectedValue(new Error('history unavailable'));
  usePiStore.setState({ selectedKey: run.key, runs: [run], history: { branch: [] } as PiHistory, sends: [], pendingPrompt: undefined, pendingPromptAt: undefined, sentAt: undefined, live: {}, toolProgress: {}, contextItems: [], draftText: '', connecting: false, changingAccessMode: false, error: undefined, notifications: [] });
});
afterAll(async () => { await vi.advanceTimersByTimeAsync(500); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('slash command disposition=handled settles the optimistic send', () => {
  it('clears the send, timer and pending prompt; restores the draft; notifies the user', async () => {
    const prompt = deferred<string | undefined>();
    api.prompt.mockReturnValueOnce(prompt.promise);
    usePiStore.getState().send('/plan 把配置页面都改到左下角齿轮');
    const state = usePiStore.getState();
    expect(state.sends).toHaveLength(1); // 乐观发送已入列
    expect(state.pendingPrompt).toBeTruthy();
    expect(state.draftText).toBe('');
    prompt.resolve('handled');
    await vi.advanceTimersByTimeAsync(50);
    const after = usePiStore.getState();
    expect(after.sends).toHaveLength(0); // 乐观发送撤下——不会有任何 run 事件
    expect(after.sentAt).toBeUndefined(); // 计时停止（WaitingProcess 空转的根源）
    expect(after.pendingPrompt).toBeUndefined();
    expect(after.draftText).toBe('/plan 把配置页面都改到左下角齿轮'); // 文字退回输入框供修改
    expect(usePiStore.getState().notifications.some(n => n.title.includes('/plan'))).toBe(true);
  });

  it('does not treat started as handled (normal run path unchanged)', async () => {
    const prompt = deferred<string | undefined>();
    api.prompt.mockReturnValueOnce(prompt.promise);
    usePiStore.getState().send('普通消息');
    prompt.resolve('started');
    await vi.advanceTimersByTimeAsync(50);
    const after = usePiStore.getState();
    expect(after.sends).toHaveLength(1); // 发送保持，等真实事件结算
    expect(after.draftText).toBe(''); // handled 收场才会恢复草稿
  });

  it('does not treat queued as handled (queue semantics unchanged)', async () => {
    const prompt = deferred<string | undefined>();
    api.prompt.mockReturnValueOnce(prompt.promise);
    usePiStore.setState({ runs: [{ ...run, status: 'running' }] });
    usePiStore.getState().send('排队消息');
    prompt.resolve('queued');
    await vi.advanceTimersByTimeAsync(50);
    const after = usePiStore.getState();
    expect(after.draftText).toBe(''); // queued 不触发 handled 收场（不恢复草稿）
    expect(after.notifications).toHaveLength(0); // 也不推「已执行命令」通知
  });
});

// ---------- backend 透传 ----------

const clients: PiRpcClient[] = [];
const roots: string[] = [];
const backends: PiBackend[] = [];

afterEach(() => {
  backends.splice(0).forEach(b => b.dispose());
  clients.splice(0).forEach(c => c.close());
  roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }));
});

async function handledBackend() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slash-handled-')); roots.push(root);
  const owned = path.join(root, 'desktop'); fs.mkdirSync(owned);
  const events: any[] = [];
  const backend = new PiBackend({ executable: process.execPath, supported: true, agentDir: root, sessionDirs: [root], diagnostics: [] }, new SessionIndex([owned], owned), owned, path.resolve('extensions/desktop-policy/index.mjs'), e => events.push(e));
  backends.push(backend);
  backend.clientFactory = (_command, args, cwd, env) => {
    const rpc = new PiRpcClient(process.execPath, [path.resolve('tests/fixtures/fake-pi.mjs'), ...args], cwd, env);
    clients.push(rpc);
    return rpc;
  };
  const launched = await backend.connect({ cwd: root, trustProject: false, permission: 'ask' });
  await backend.prompt(launched.key, '/swallow', 'followUp');
  return { backend, launched };
}

describe('backend prompt returns pi disposition', () => {
  it("returns 'handled' for extension commands that swallow the text", async () => {
    const { backend, launched } = await handledBackend();
    const disposition = await backend.prompt(launched.key, '/swallow extra words', 'followUp');
    expect(disposition).toBe('handled');
    expect(backend.runs().find(r => r.key === launched.key)?.status).toBe('idle'); // 无 run 启动
  });

  it("withdraws the optimistic queue entry when a running send is 'handled'", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slash-queued-')); roots.push(root);
    const owned = path.join(root, 'desktop'); fs.mkdirSync(owned);
    const backend = new PiBackend({ executable: process.execPath, supported: true, agentDir: root, sessionDirs: [root], diagnostics: [] }, new SessionIndex([owned], owned), owned, path.resolve('extensions/desktop-policy/index.mjs'), () => {});
    backends.push(backend);
    backend.clientFactory = (_command, args, cwd, env) => {
      const rpc = new PiRpcClient(process.execPath, [path.resolve('tests/fixtures/fake-pi.mjs'), ...args], cwd, env);
      clients.push(rpc);
      return rpc;
    };
    const launched = await backend.connect({ cwd: root, trustProject: false, permission: 'ask' });
    // /long 让 fake-pi 进入 streaming（agent_start → running），乐观队列条目入列
    await backend.prompt(launched.key, '/long', 'followUp');
    await vi.waitFor(() => expect(backend.runs().find(r => r.key === launched.key)?.status).toBe('running'));
    const disposition = await backend.prompt(launched.key, '/swallow-queued', 'followUp');
    expect(disposition).toBe('handled');
    const view = backend.runs().find(r => r.key === launched.key);
    expect(view?.queue ?? []).toHaveLength(0); // 乐观条目已撤回（不会等 queue_update）
    expect(view?.pending ?? 0).toBe(0);
  });

  it('passes through non-handled dispositions', async () => {
    const { backend, launched } = await handledBackend();
    const disposition = await backend.prompt(launched.key, '/boundary', 'followUp');
    expect(disposition).toBe('started'); // fake-pi 对未知消息回 ok({}) → 默认 started
  });
});

describe('handled with a running send (queued optimistic entry)', () => {
  it('withdraws the optimistic queue entry and pending badge, restores the draft in the owning session', async () => {
    usePiStore.setState({ runs: [{ ...run, status: 'running', queue: [], pending: 0 }] });
    const prompt = deferred<string | undefined>();
    api.prompt.mockReturnValueOnce(prompt.promise);
    usePiStore.getState().send('/plan 运行中发的命令');
    const queuedState = usePiStore.getState();
    const target = queuedState.runs.find(r => r.key === run.key)!;
    expect(target.pending ?? 0).toBe(1); // 乐观队列条目已入列
    prompt.resolve('handled');
    await vi.advanceTimersByTimeAsync(50);
    const after = usePiStore.getState();
    const view = after.runs.find(r => r.key === run.key)!;
    expect(view.queue ?? []).toHaveLength(0); // 乐观条目撤下（不会等 queue_update）
    expect(view.pending ?? 0).toBe(0);
    expect(after.draftText).toBe('/plan 运行中发的命令'); // 归属会话恢复草稿
  });

  it('never overwrites another session draft the user is typing into', async () => {
    usePiStore.setState({ runs: [run], sends: [], draftText: '', contextItems: [], sentAt: undefined });
    const prompt = deferred<string | undefined>();
    api.prompt.mockReturnValueOnce(prompt.promise);
    usePiStore.getState().send('/plan 会话A的命令');
    // await 期间用户切到会话 B 并开始打字
    usePiStore.setState({ selectedKey: 'other-session', draftText: '用户正在B会话输入' });
    prompt.resolve('handled');
    await vi.advanceTimersByTimeAsync(50);
    const after = usePiStore.getState();
    expect(after.draftText).toBe('用户正在B会话输入'); // B 草稿不被覆写
    expect(after.notifications.some(n => n.title.includes('/plan'))).toBe(true); // 提示仍给出
    usePiStore.setState({ selectedKey: run.key });
  });
});
