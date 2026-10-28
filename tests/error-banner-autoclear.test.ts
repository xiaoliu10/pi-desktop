// 全局错误呈现：不要大红横幅、不要必须手点（用户 2026-10-28 反馈）。
// 期望：错误仍由 error/errorKey 承载，但会在会话恢复（agent_start / compaction_end）
// 或重发成功时自动清除；手动 dismissError 保留为兜底；跨会话互不影响。
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { usePiStore } from '../src/renderer/pi/adapter';
import type { PiRun } from '../src/shared/pi';

let emit: (event: any) => void;
let api: any;
const run = (key: string): PiRun => ({ key, generation: 'g1', cwd: '/p', status: 'idle', models: [], commands: [], pending: 0 });

beforeAll(async () => {
  vi.useFakeTimers();
  api = {
    settingsSnapshot: vi.fn().mockRejectedValue('mock'), environment: vi.fn().mockRejectedValue('mock'),
    sessions: vi.fn().mockResolvedValue([]), runs: vi.fn().mockResolvedValue([]), archivedSessions: vi.fn().mockResolvedValue([]),
    onEvent: (fn: typeof emit) => { emit = fn; },
    recoverSubagents: vi.fn().mockResolvedValue({ unchanged: true }),
    prompt: vi.fn(async () => { throw new Error('pi 进程已退出 (SIGKILL)。'); }),
    history: vi.fn().mockResolvedValue({ branch: [], leafId: null }),
  };
  vi.stubGlobal('window', { localPi: api, crypto: globalThis.crypto });
  usePiStore.getState().init();
  await vi.advanceTimersByTimeAsync(0);
});
afterAll(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const reset = (extra: Record<string, unknown> = {}) => usePiStore.setState({
  selectedKey: 'k-1', runs: [run('k-1')], history: undefined, sends: [], live: {}, toolProgress: {}, retrying: {},
  contextItems: [], connecting: false, changingAccessMode: false, pendingSteer: {}, draftText: '', text: '',
  error: undefined, errorKey: undefined, view: 'chat', ...extra,
} as any);

it('a failed send writes the error banner state (unchanged path)', async () => {
  reset();
  usePiStore.getState().send('你好');
  await vi.advanceTimersByTimeAsync(50);
  const s = usePiStore.getState() as any;
  expect(s.error).toContain('pi 进程已退出');
  expect(s.errorKey).toBe('k-1');
});

it('agent_start clears the error without a manual dismiss', () => {
  reset({ error: 'pi 进程已退出 (SIGKILL)。', errorKey: 'k-1' });
  emit({ type: 'rpc', key: 'k-1', generation: 'g1', event: { type: 'agent_start' } });
  expect((usePiStore.getState() as any).error).toBeUndefined();
});

it('compaction_end also clears the error', () => {
  reset({ error: '上一轮失败', errorKey: 'k-1' });
  emit({ type: 'rpc', key: 'k-1', generation: 'g1', event: { type: 'compaction_end' } });
  expect((usePiStore.getState() as any).error).toBeUndefined();
});

it('does not clear another session error', () => {
  reset({ runs: [run('k-1'), run('k-2')], error: '别的会话失败', errorKey: 'k-2' });
  emit({ type: 'rpc', key: 'k-1', generation: 'g1', event: { type: 'agent_start' } });
  expect((usePiStore.getState() as any).error).toBe('别的会话失败');
});

it('dismissError still works as a manual fallback', () => {
  reset({ error: '模型目录加载失败' });
  usePiStore.getState().dismissError();
  expect((usePiStore.getState() as any).error).toBeUndefined();
});
