import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatView } from '../src/renderer/replica/chat/ChatView';
import type { ChatViewProps, ChatMessage } from '../src/renderer/replica/contracts';

const labels = { you: '你', assistant: '助手', simulatedRun: '模拟', toolRunning: '运行中', toolDone: '完成', toolError: '出错', working: '工作中', queued: '已排队', jumpToMessage: '跳转' } as unknown as ChatViewProps['labels'];
const base = { onJumpToMessage: () => undefined, demo: true, running: false, queued: 0, messages: [], labels } as unknown as ChatViewProps;

describe('thinking excerpt plain text', () => {
  it('does not leak literal markdown ** in the collapsed summary (model writes bold titles)', () => {
    // 模型经路由返回的思考摘要常是 `**Doing X**` 形式；折叠态摘要要把星号去掉，不能露字面 **。
    const thinking: ChatMessage = { id: 'm1', timestamp: 1, role: 'assistant', parts: [{ kind: 'thinking', id: 't1', text: '**Investigating SDK support**' }] };
    const html = renderToStaticMarkup(createElement(ChatView, { ...base, messages: [thinking] }));
    expect(html).toContain('Investigating SDK support');
    expect(html).not.toContain('**');
  });
  it('keeps inline code backticks out of the excerpt but visible in the body', () => {
    const thinking: ChatMessage = { id: 'm1', timestamp: 1, role: 'assistant', parts: [{ kind: 'thinking', id: 't1', text: 'Looking at `parseContextPrompt` to round-trip.' }] };
    const html = renderToStaticMarkup(createElement(ChatView, { ...base, messages: [thinking] }));
    expect(html).toContain('parseContextPrompt');
    expect(html).not.toMatch(/`parseContextPrompt`/); // 摘要里不应有字面反引号
  });
});
