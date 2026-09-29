// 错误横幅的会话隔离：错误盖章 errorKey（来源会话），切换到其他会话后不再展示。
// 起因：pi-waker 会话点停止的报错出现在另一个正常项目的会话顶部（用户反馈）。
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { usePiStore } from '../src/renderer/pi/adapter';
import type { PiRun } from '../src/shared/pi';

let emit: (event: any) => void;
let api: any;
let run: PiRun;

beforeAll(async () => {
  vi.useFakeTimers();
  api = {
    settingsSnapshot: vi.fn().mockRejectedValue('mock'), environment: vi.fn().mockRejectedValue('mock'),
    sessions: vi.fn().mockResolvedValue([]), runs: vi.fn().mockResolvedValue([]), archivedSessions: vi.fn().mockResolvedValue([]),
    onEvent: (fn: typeof emit) => { emit = fn; }, history: vi.fn(), prompt: vi.fn(() => new Promise(() => {})),
    stop: vi.fn().mockRejectedValue(new Error('abort 超时；未自动重试，执行状态可能未知。')),
  };
  vi.stubGlobal('window', { localPi: api });
  usePiStore.getState().init();
  await vi.advanceTimersByTimeAsync(0);
});
afterAll(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('run-scoped errors are stamped with their session and hidden from other sessions', async () => {
  run = { key: 'k-waker', generation: 'g1', cwd: '/waker', status: 'running', models: [], commands: [], pending: 0 };
  usePiStore.setState({ selectedKey: 'k-waker', runs: [run], history: undefined, sends: [], live: {}, toolProgress: {}, retrying: {}, contextItems: [], connecting: false, changingAccessMode: false, pendingSteer: {}, draftText: '', error: undefined, errorKey: undefined });

  // 1) stop 失败（attempt 路径）：错误盖章当前会话
  usePiStore.getState().stop();
  await vi.advanceTimersByTimeAsync(50);
  let s = usePiStore.getState();
  expect(s.error).toContain('abort 超时');
  expect(s.errorKey).toBe('k-waker');

  // 2) 切到另一个会话：横幅条件不成立（组件按 errorKey === selectedKey 过滤）
  usePiStore.setState({ selectedKey: 'k-other' });
  s = usePiStore.getState();
  const visibleInOther = !!(s.error && (!s.errorKey || s.errorKey === s.selectedKey));
  expect(visibleInOther).toBe(false);

  // 3) 切回来源会话：错误仍然可见（错误属于那个会话，直到被关闭或覆盖）
  usePiStore.setState({ selectedKey: 'k-waker' });
  s = usePiStore.getState();
  expect(!!(s.error && (!s.errorKey || s.errorKey === s.selectedKey))).toBe(true);

  // 4) 关闭错误后彻底清除（含 errorKey）
  usePiStore.getState().dismissError();
  expect(usePiStore.getState().error).toBeUndefined();
  expect(usePiStore.getState().errorKey).toBeUndefined();

  // 5) run 事件携带 error：归属该 run 的会话，不污染当前会话
  usePiStore.setState({ selectedKey: 'k-other', error: undefined, errorKey: undefined, runs: [run] });
  emit({ type: 'run', run: { ...run, error: '停止未确认，追问已保留；请再次停止。' } });
  s = usePiStore.getState();
  expect(s.error).toContain('停止未确认');
  expect(s.errorKey).toBe('k-waker');
  const visibleInOther2 = !!(s.error && (!s.errorKey || s.errorKey === s.selectedKey));
  expect(visibleInOther2).toBe(false);
});
