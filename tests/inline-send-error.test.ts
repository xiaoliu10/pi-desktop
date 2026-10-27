// 发送被「临时状态」拒绝时的错误呈现（用户 2026-10-27 反馈）：
// 压缩进行中发送会拿到 pi 的 "Cannot submit a prompt while compaction is in progress"，
// 此前它被写进全局错误横幅，压缩结束后横幅仍挂着不消失，只能手点 ×。
// 期望：这类错误进对话流（会话内错误卡），会话恢复后自动消失；真正的失败仍走横幅。
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { isTransientSendError, transientSendErrorSummary } from '../src/shared/send-error';
import { usePiStore } from '../src/renderer/pi/adapter';
import { ChatView } from '../src/renderer/replica/chat/ChatView';
import { replicaLabels } from '../src/renderer/replica/i18n';
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
  error: undefined, errorKey: undefined, sendError: undefined, view: 'chat', ...extra,
} as any);

it('classifies transient rejections and strips the IPC prefix', () => {
  expect(isTransientSendError(COMPACTING)).toBe(true);
  expect(isTransientSendError('当前会话暂不能发送；请先停止确认执行状态')).toBe(true);
  expect(isTransientSendError('pi 已退出 (SIGKILL)。')).toBe(false);
  expect(isTransientSendError('')).toBe(false);
  expect(transientSendErrorSummary(COMPACTING)).toBe('Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.');
});

it('a send rejected while compacting goes inline, not to the global banner', async () => {
  reset();
  usePiStore.getState().send('你好');
  await vi.advanceTimersByTimeAsync(50);
  const s = usePiStore.getState() as any;
  expect(s.error).toBeUndefined();
  expect(s.sendError?.key).toBe('k-1');
  expect(s.sendError?.message).toContain('Cannot submit a prompt while compaction');
  // 发送失败仍要还原草稿，用户重新发送不用重打
  expect(s.draftText).toBe('你好');
});

it('compaction_end and the next run start clear the inline error', async () => {
  reset({ sendError: { key: 'k-1', message: COMPACTING, at: 1 } });
  emit({ type: 'rpc', key: 'k-1', generation: 'g1', event: { type: 'compaction_end' } });
  expect((usePiStore.getState() as any).sendError).toBeUndefined();

  usePiStore.setState({ sendError: { key: 'k-1', message: COMPACTING, at: 1 } } as any);
  emit({ type: 'rpc', key: 'k-1', generation: 'g1', event: { type: 'agent_start' } });
  expect((usePiStore.getState() as any).sendError).toBeUndefined();
});

it('does not clear another session inline error', () => {
  reset({ sendError: { key: 'k-2', message: COMPACTING, at: 1 } });
  emit({ type: 'rpc', key: 'k-1', generation: 'g1', event: { type: 'compaction_end' } });
  expect((usePiStore.getState() as any).sendError?.key).toBe('k-2');
});

it('a real failure still uses the global banner', async () => {
  reset();
  api.prompt = vi.fn(async () => { throw new Error('pi 已退出 (SIGKILL)。'); });
  usePiStore.getState().send('你好');
  await vi.advanceTimersByTimeAsync(50);
  const s = usePiStore.getState() as any;
  expect(s.error).toContain('pi 已退出');
  expect(s.sendError).toBeUndefined();
});

it('renders the inline error card at the end of the conversation', () => {
  const html = renderToStaticMarkup(createElement(ChatView, {
    messages: [], demo: false, labels: replicaLabels('zh').chat, onJumpToMessage: () => {},
    sendError: { key: 'k-1', message: COMPACTING, at: 1 },
  } as any));
  expect(html).toContain('pi-send-error');
  expect(html).toContain('Cannot submit a prompt while compaction is in progress');
  expect(html).not.toContain("Error invoking remote method");
  expect(html).toContain('压缩完成后会自动消失');
});
