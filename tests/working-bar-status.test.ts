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

  it('shows no status text during a model auto-retry', () => {
    const html = renderToStaticMarkup(createElement(ChatView, { ...base, running: true, messages: [doneTool('bash', 'ls')], retrying: { attempt: 2, max: 3 } }));
    expect(html).toContain('pi-chat__working');
    expect(html).not.toContain('pi-chat__working-now');
  });

  it('shows no tool name text when a tool is running', () => {
    const html = renderToStaticMarkup(createElement(ChatView, { ...base, running: true, messages: [runningTool('bash', 'git status')] }));
    expect(html).toContain('pi-chat__working');
    expect(html).not.toContain('pi-chat__working-now');
  });

  it('renders no working bar when idle and not sending', () => {
    const html = renderToStaticMarkup(createElement(ChatView, base));
    expect(html).not.toContain('pi-chat__working');
  });
});
