// 发送被「压缩进行中」拒绝时的呈现策略（用户 2026-10-28 反馈：连错误卡也取消）：
// 完全静默——不进全局横幅、不进对话流错误卡；正文退回输入框，等压缩结束后重发。
// 只有真实失败（连接数满、模型刷新、进程退出等）才走全局横幅。
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { classifyTransientSendError } from '../src/shared/send-error';
import { usePiStore } from '../src/renderer/pi/adapter';
import type { PiRun } from '../src/shared/pi';

const COMPACTING = "Error invoking remote method 'local-pi:prompt': Error: Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.";

let emit: (event: any) => void;
let api: any;
const run = (): PiRun => ({ key: 'k-1', generation: 'g1', cwd: '/p', status: 'idle', models: [], commands: [], pending: 0 });

beforeAll(async () => {
  vi.useFakeTimers();
  api = {
    settingsSnapshot: vi.fn().mockRejectedValue('mock'), environment: vi.fn().mockRejectedValue('mock'),
    sessions: vi.fn().mockResolvedValue([]), runs: vi.fn().mockResolvedValue([]), archivedSessions: vi.fn().mockResolvedValue([]),
    onEvent: (fn: typeof emit) => { emit = fn; },
    recoverSubagents: vi.fn().mockResolvedValue({ unchanged: true }),
    prompt: vi.fn(async () => { throw new Error(COMPACTING); }),
    history: vi.fn().mockResolvedValue({ branch: [], leafId: null }),
  };
  vi.stubGlobal('window', { localPi: api, crypto: globalThis.crypto });
  usePiStore.getState().init();
  await vi.advanceTimersByTimeAsync(0);
});
afterAll(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const reset = (extra: Record<string, unknown> = {}) => usePiStore.setState({
  selectedKey: 'k-1', runs: [run()], history: undefined, sends: [], live: {}, toolProgress: {}, retrying: {},
  contextItems: [], connecting: false, changingAccessMode: false, pendingSteer: {}, draftText: '', text: '',
  error: undefined, errorKey: undefined, view: 'chat', ...extra,
} as any);

it('classification only matches the kernel compaction rejection', () => {
  expect(classifyTransientSendError(COMPACTING)).toBe('compaction');
  // 真实失败不得误判为临时（审查 P1 的口径保持不变）
  expect(classifyTransientSendError('最多同时连接 5 个会话，且都在运行或等待交互；请稍后再试。')).toBeNull();
  expect(classifyTransientSendError('正在刷新模型配置，请稍后再试。')).toBeNull();
  expect(classifyTransientSendError('当前会话暂不能发送；请先停止确认执行状态')).toBeNull();
  expect(classifyTransientSendError('正在退出')).toBeNull();
  expect(classifyTransientSendError('pi 已退出 (SIGKILL)。')).toBeNull();
  expect(classifyTransientSendError('')).toBeNull();
});

it('a send rejected while compacting is fully silent: no banner, no card, draft restored', async () => {
  reset();
  usePiStore.getState().send('你好');
  await vi.advanceTimersByTimeAsync(50);
  const s = usePiStore.getState() as any;
  expect(s.error).toBeUndefined();
  expect(s.sendError).toBeUndefined();
  // 发送计时收口，正文退回输入框，等压缩结束后用户自行重发
  expect(s.sentAt).toBeUndefined();
  expect(s.draftText).toBe('你好');
});

it('real failures still use the global banner', async () => {
  reset();
  api.prompt = vi.fn(async () => { throw new Error('最多同时连接 5 个会话，且都在运行或等待交互；请稍后再试。'); });
  usePiStore.getState().send('继续');
  await vi.advanceTimersByTimeAsync(50);
  const s = usePiStore.getState() as any;
  expect(s.error).toContain('最多同时连接');
  expect(s.sendError).toBeUndefined();
});
