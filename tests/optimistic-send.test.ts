import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatView } from '../src/renderer/replica/chat/ChatView';
import type { ChatViewProps } from '../src/renderer/replica/contracts';

const base = {
  onJumpToMessage: () => undefined,
  demo: true,
  running: false,
  queued: 0,
  messages: [],
  labels: { you: '你', assistant: '助手', simulatedRun: '模拟', toolRunning: '运行中', toolDone: '完成', toolError: '出错', working: '工作中', queued: '排队', jumpToMessage: '跳转' },
} as unknown as ChatViewProps;

describe('optimistic send feedback', () => {
  it('shows the working spinner immediately while sending', () => {
    const html = renderToStaticMarkup(createElement(ChatView, { ...base, sending: true, sendingText: '帮我修复登录页' }));
    expect(html).toContain('pi-chat__working');
    expect(html).toContain('pi-spinner');
    // 用户文本立即以气泡形式出现，不用等 pi 回显
    expect(html).toContain('帮我修复登录页');
    expect(html).toContain('pi-msg--pending');
  });

  it('ticks the working timer from the client send time during the ack→agent_start gap', () => {
    const html = renderToStaticMarkup(createElement(ChatView, { ...base, sending: true, sendingAt: Date.now() - 65_000 }));
    expect(html).toContain('pi-chat__working');
    // 计时从发送时刻起跳（1 分钟级别），而不是等 agent_start 才从 0 开始
    expect(html).toContain('已工作');
    expect(html).toContain('1');
  });

  it('shows nothing extra when not sending and idle', () => {
    const html = renderToStaticMarkup(createElement(ChatView, base));
    expect(html).not.toContain('pi-chat__working');
    expect(html).not.toContain('pi-msg--pending');
  });
});
