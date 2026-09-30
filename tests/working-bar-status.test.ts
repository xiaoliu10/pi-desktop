import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatView } from '../src/renderer/replica/chat/ChatView';
import type { ChatViewProps, ChatMessage } from '../src/renderer/replica/contracts';

const labels = {
  you: '你', assistant: '助手', simulatedRun: '模拟', toolRunning: '运行中', toolDone: '完成', toolError: '出错', working: '工作中', queued: '已排队', jumpToMessage: '跳转',
} as unknown as ChatViewProps['labels'];

const base = {
  onJumpToMessage: () => undefined,
  demo: true,
  running: false,
  queued: 0,
  messages: [],
  labels,
} as unknown as ChatViewProps;

const doneTool = (tool: string, summary: string): ChatMessage => ({
  id: 'm1', timestamp: 1, role: 'assistant', model: 'x',
  parts: [{ kind: 'tool', id: 't1', callId: 'c1', phase: 'call', tool, summary, argumentsText: '', status: 'done', detailLines: [''] }],
});

const runningTool = (tool: string, summary: string): ChatMessage => ({
  id: 'm1', timestamp: 1, role: 'assistant', model: 'x',
  parts: [{ kind: 'tool', id: 't1', callId: 'c1', phase: 'progress', tool, summary, argumentsText: '', status: 'running', detailLines: [''] }],
});

describe('working bar status text', () => {
  it('shows spinner without status text when running between steps', () => {
    const html = renderToStaticMarkup(createElement(ChatView, { ...base, running: true, messages: [doneTool('bash', 'ls')] }));
    expect(html).toContain('pi-chat__working');
    expect(html).toContain('pi-spinner');
    expect(html).not.toContain('pi-chat__working-now');
  });

  it('replaces the ordinary working bar with the actual retry count', () => {
    const html = renderToStaticMarkup(createElement(ChatView, { ...base, running: true, messages: [doneTool('bash', 'ls')], retrying: { attempt: 2, max: 3 } }));
    expect(html).toContain('pi-chat__retry');
    expect(html).toContain('正在重试请求（第 2/3 次）');
    expect(html).toContain('等待模型响应…');
    expect(html).not.toContain('class="pi-chat__working"');
  });

  it('shows no tool name text when a tool is running', () => {
    const html = renderToStaticMarkup(createElement(ChatView, { ...base, running: true, messages: [runningTool('bash', 'git status')] }));
    expect(html).toContain('pi-chat__working');
    expect(html).not.toContain('pi-chat__working-now');
  });

  it('always exposes a process disclosure while waiting with no process output', () => {
    const html = renderToStaticMarkup(createElement(ChatView, { ...base, running: true, messages: [{ id: 'waiting-user', role: 'user', parts: [{ id: 'waiting-text', kind: 'text', text: 'hi' }] }], runTiming: { startedAt: 1 }, onRefreshProcess: async () => true }));
    expect(html).toContain('pi-waiting-process');
    expect(html).toContain('查看过程');
    expect(html).toContain('重新同步过程');
    expect(html).toContain('本轮当前没有可展示的思考或工具过程');
    expect(html).toContain('不代表已验证请求仍在运行');
    expect(html).not.toMatch(/<details[^>]*\sopen=/);
  });

  it('renders no working bar when idle and not sending', () => {
    const html = renderToStaticMarkup(createElement(ChatView, base));
    expect(html).not.toContain('pi-chat__working');
  });
});
