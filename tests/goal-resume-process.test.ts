// /goal-resume（扩展命令）轮次的过程展示回归：扩展命令不落 user 条目（只有 system +
// custom_message pi-goal-event），乐观 send 永远等不到确认边界。重放真实事件序列，
// 断言实时 thinking/tool 过程仍然渲染（不出现「本轮当前没有可展示的思考或工具过程」）。
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { isAwaitingSend, sentConversationMessages, usePiStore } from '../src/renderer/pi/adapter';
import { ChatView } from '../src/renderer/replica/chat/ChatView';
import { replicaLabels } from '../src/renderer/replica/i18n';
import type { PiEntry, PiHistory, PiRun } from '../src/shared/pi';
import real from './fixtures/goal-resume-branch.json';

const before = real.before as PiEntry[];
const after = real.after as PiEntry[];
const questionId = before[0].id as string;

let emit: (event: any) => void;
let api: any;
let run: PiRun;
let serial = 0;
const rpc = (event: any) => emit({ type: 'rpc', key: run.key, generation: run.generation, event });
const messages = () => {
  const s = usePiStore.getState();
  return sentConversationMessages(s.history?.branch ?? [], s.live[run.key], s.toolProgress[run.key], s.sends.filter(x => x.key === run.key));
};
const html = () => renderToStaticMarkup(createElement(ChatView, {
  messages: messages(), running: true, queued: 0, demo: true,
  labels: replicaLabels('zh').chat, onRefreshProcess: usePiStore.getState().refreshConversation,
}));
const refresh = async (branch: PiEntry[]) => {
  api.history.mockResolvedValue({ branch } as PiHistory);
  const result = usePiStore.getState().refreshConversation();
  await vi.advanceTimersByTimeAsync(500);
  expect(await result).toBe(true);
};

beforeAll(async () => {
  vi.useFakeTimers();
  api = {
    settingsSnapshot: vi.fn().mockRejectedValue('mock'), environment: vi.fn().mockRejectedValue('mock'),
    sessions: vi.fn().mockResolvedValue([]), runs: vi.fn().mockResolvedValue([]), archivedSessions: vi.fn().mockResolvedValue([]),
    onEvent: (fn: typeof emit) => { emit = fn; }, history: vi.fn(), prompt: vi.fn(async () => { await Promise.resolve(); }),
  };
  vi.stubGlobal('window', { localPi: api });
  usePiStore.getState().init();
  await vi.advanceTimersByTimeAsync(0);
});
beforeEach(() => {
  run = { key: `goal-${++serial}`, generation: `generation-${serial}`, cwd: '/synthetic', status: 'idle', models: [], commands: [], pending: 0 };
  api.history.mockReset();
  api.history.mockResolvedValue({ branch: before } as PiHistory);
  usePiStore.setState({ selectedKey: run.key, runs: [run], history: { branch: before } as PiHistory, sends: [], live: {}, toolProgress: {}, retrying: {}, contextItems: [], connecting: false, changingAccessMode: false, pendingSteer: {}, draftText: '' });
});
afterAll(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('extension-command turns keep streaming process visible without a user boundary', async () => {
  // 1) 用户发送 /goal-resume：真实 send 路径（乐观气泡 + prompt + promptDone）
  usePiStore.getState().send('/goal-resume');
  await vi.advanceTimersByTimeAsync(50);
  const sends = usePiStore.getState().sends.filter(s => s.key === run.key);
  expect(sends).toHaveLength(1);
  const goalSend = sends[0];
  expect(goalSend.text).toBe('/goal-resume');
  expect(isAwaitingSend(goalSend)).toBe(true);

  // 2) 扩展命令执行：system + custom_message(pi-goal-event) 先落盘，无任何 user 条目
  // 3) 50ms 后调度器触发续接轮：agent_start + assistant 流式 thinking
  rpc({ type: 'agent_start' });
  const ts = 1790607988000;
  rpc({ type: 'message_start', message: { role: 'assistant', timestamp: ts, content: [] } });
  rpc({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: '恢复目标：从 typecheck 开始继续' } });

  // 磁盘尚未赶上时的实时视图：过程必须可见
  await vi.advanceTimersByTimeAsync(200);
  expect(JSON.stringify(messages())).toContain('恢复目标：从 typecheck 开始继续');
  expect(html()).not.toContain('pi-waiting-process');

  // 4) 磁盘赶上：system/custom_message/已保存 assistant 落盘，乐观 send 依旧无边界
  await refresh(after);
  expect(usePiStore.getState().sends.find(s => s.id === goalSend.id)?.confirmedId).toBeUndefined();
  // 实时流仍然归属本轮并在最后一段渲染
  expect(JSON.stringify(messages())).toContain('恢复目标：从 typecheck 开始继续');
  expect(html()).not.toContain('pi-waiting-process');

  // 5) 落盘的恢复工作必须排在 /goal-resume 气泡之后（baseline 锚定），而不是冒充上一轮内容
  const ordered = messages();
  const bubble = ordered.findIndex(m => m.role === 'user' && JSON.stringify(m.parts).includes('/goal-resume'));
  const resumed = ordered.findIndex(m => JSON.stringify(m).includes('847b5a16'));
  expect(bubble).toBeGreaterThanOrEqual(0);
  expect(resumed).toBeGreaterThan(bubble);

  // 6) 后续 thinking delta 保持归属
  rpc({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: '；先修类型错误' } });
  await vi.advanceTimersByTimeAsync(200);
  expect(JSON.stringify(messages())).toContain('先修类型错误');
  expect(html()).not.toContain('pi-waiting-process');
});
