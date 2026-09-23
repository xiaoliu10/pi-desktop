import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConversationStatusPanel } from '../src/renderer/pi/ConversationStatusPanel';
import type { ChatMessage } from '../src/renderer/replica/contracts';
import type { PiSessionStats } from '../src/shared/pi';

// node 测试环境没有 localStorage（面板用它记忆折叠状态）
const store = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
(globalThis as any).window = { innerWidth: 1200 };

const base = { cwd: undefined, messages: [] as ChatMessage[], running: false, onReview: () => undefined, onRequest: () => undefined };

describe('status panel session stats', () => {
  it('renders token breakdown, cost and counts from pi get_session_stats', () => {
    const stats: PiSessionStats = { tokens: { input: 15234, output: 4567, cacheRead: 1_250_000, cacheWrite: 3200, total: 1_273_001 }, cost: 0.1234, totalMessages: 42, toolCalls: 17 };
    const html = renderToStaticMarkup(createElement(ConversationStatusPanel, { ...base, stats }));
    expect(html).toContain('会话统计');
    expect(html).toContain('1.27M tokens');
    expect(html).toContain('15.2k');   // 输入
    expect(html).toContain('4.6k');    // 输出
    expect(html).toContain('1.25M');   // 缓存
    expect(html).toContain('$0.12');   // 费用
    expect(html).toContain('42');      // 消息
    expect(html).toContain('17');      // 工具调用
  });
  it('hides the stats section when there is no stats snapshot', () => {
    const html = renderToStaticMarkup(createElement(ConversationStatusPanel, base));
    expect(html).not.toContain('会话统计');
  });
  it('hides when total tokens is zero (fresh session)', () => {
    const stats: PiSessionStats = { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const html = renderToStaticMarkup(createElement(ConversationStatusPanel, { ...base, stats }));
    expect(html).not.toContain('会话统计');
  });
});
