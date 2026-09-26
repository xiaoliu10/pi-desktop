import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { usePiStore } from '../src/renderer/pi/adapter';
import type { PiEntry, PiHistory, PiRun } from '../src/shared/pi';

// 切屏/切会话回来后过程块消失：selectSession 清空 history 后首次加载失败会永久空白；
// run 卡在 running 时工作条永续计时。这里覆盖两条自愈路径 + focus reconcile。
const run: PiRun = { key: 'reconcile-test', generation: 'g', cwd: '/mock', file: '/mock/session', status: 'idle', models: [], commands: [], pending: 0 };
const entry = (id: string, role: string, content: unknown): PiEntry => ({ id, type: 'message', message: { role, content } } as PiEntry);
const history = (branch: PiEntry[]) => ({ branch } as PiHistory);
let emit: (e: any) => void;
let api: any;

beforeAll(() => {
  vi.useFakeTimers();
  api = { settingsSnapshot: vi.fn().mockRejectedValue('mock'), environment: vi.fn().mockRejectedValue('mock'), sessions: vi.fn().mockResolvedValue([]), runs: vi.fn().mockResolvedValue([]), archivedSessions: vi.fn().mockResolvedValue([]), onEvent: (fn: typeof emit) => { emit = fn; }, prompt: vi.fn(), history: vi.fn() };
  vi.stubGlobal('window', { localPi: api, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: vi.fn(), removeEventListener: vi.fn() });
  usePiStore.getState().init();
});
beforeEach(async () => {
  await vi.advanceTimersByTimeAsync(500);
  api.history.mockReset(); api.runs.mockReset();
  usePiStore.setState({ selectedKey: run.key, runs: [run], history: undefined, sends: [], pendingPrompt: undefined, pendingPromptAt: undefined, sentAt: undefined, pendingSteer: {}, live: {}, toolProgress: [], contextItems: [], draftText: '', connecting: false, changingAccessMode: false, error: undefined });
});
afterAll(async () => { await vi.advanceTimersByTimeAsync(500); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('重试首次加载失败的会话历史：失败后退避重试直到成功，流不再永久空白', async () => {
  api.history.mockRejectedValueOnce(new Error('pi busy')).mockRejectedValueOnce(new Error('pi busy'));
  api.history.mockResolvedValueOnce(history([entry('u1', 'user', 'hi'), entry('a1', 'assistant', 'done')]));
  // selectSession：置 history=undefined（无旧历史可保留）+ 触发首次加载
  usePiStore.getState().selectSession(run.key);
  await vi.advanceTimersByTimeAsync(500); // 400ms debounce + 第 1 次失败
  expect(usePiStore.getState().history).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1000); // 退避 1s → 第 2 次失败

  expect(usePiStore.getState().history).toBeUndefined();
  await vi.advanceTimersByTimeAsync(2000); // 退避 2s → 第 3 次成功

  const hist = usePiStore.getState().history;
  expect(hist?.branch.map(e => e.id)).toEqual(['u1', 'a1']);
});

it('切屏回来 focus reconcile：pi 侧已结束的卡死 run 被拉直为 idle，并刷新历史', async () => {
  // 本地卡死：running + 工作计时来源 sentAt
  usePiStore.setState({
    runs: [{ ...run, status: 'running' }],
    sentAt: { key: run.key, at: Date.now(), text: 'x' },
    history: history([entry('u1', 'user', 'hi')]),
  });
  // pi 侧快照：同一 run 已 idle（事件丢失场景）
  api.runs.mockResolvedValue([{ ...run, status: 'idle' }]);
  api.history.mockResolvedValue(history([entry('u1', 'user', 'hi'), entry('a1', 'assistant', 'done')]));
  (usePiStore.getState().init as any)(); // 幂等：不会重启，但确保监听已挂（first init 已挂）
  // 手动触发 reconcile 的内部逻辑：直接调 focus 监听不可达（stub 掉了 addEventListener），
  // 这里通过 dispatch window focus 事件不可行 → 改为直接验证 reconcile 的效果路径：
  // focus 时 runs() 被调用且结果落盘。模拟：调用 store 暴露不了 reconcile → 通过 init 的
  // window focus listener stub 记录参数后手动调用。
  const listener = (window.addEventListener as any).mock.calls.find(([event]: any[]) => event === 'focus')?.[1];
  expect(typeof listener).toBe('function');
  listener();
  await vi.advanceTimersByTimeAsync(600);
  const state = usePiStore.getState();
  expect(state.runs.find(r => r.key === run.key)?.status).toBe('idle');
  expect(state.sentAt).toBeUndefined();
  expect(state.history?.branch.map(e => e.id)).toEqual(['u1', 'a1']);
});

it('pi 侧确实还在跑时不拉直本地 run', async () => {
  usePiStore.setState({ runs: [{ ...run, status: 'running' }], sentAt: { key: run.key, at: Date.now(), text: 'x' } });
  api.runs.mockResolvedValue([{ ...run, status: 'running' }]);
  api.history.mockResolvedValue(history([entry('u1', 'user', 'hi')]));
  const listener = (window.addEventListener as any).mock.calls.find(([event]: any[]) => event === 'focus')?.[1];
  listener();
  await vi.advanceTimersByTimeAsync(600);
  expect(usePiStore.getState().runs.find(r => r.key === run.key)?.status).toBe('running');
  expect(usePiStore.getState().sentAt).toBeDefined();
});
