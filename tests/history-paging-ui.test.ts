import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { ChatView } from '../src/renderer/replica/chat/ChatView';
import { historyToMessages } from '../src/renderer/pi/adapter';
import type { ChatViewProps } from '../src/renderer/replica/contracts';

// 分页补拉契约（用户 2026-10-18：「不回滚，要优化」——首屏 tail + 无缝补拉）：
// 1) 已载入范围没展开完时，按钮是「更早的消息 · 还有 N 轮」（N 只数已载入部分）
// 2) 已载入范围展开完、而盘上还有更多（earlierTotal > turns.length）时，按钮改显示
//    真实剩余量并触发 onLoadEarlier——不能消失（那正是 tail=500 首屏被误判为「只剩三段」的形态）
// 3) 补拉中按钮禁用 + 显示加载态
const labels = { you: '你', assistant: 'pi', simulatedRun: '演示', toolRunning: '运行中', toolDone: '完成', toolError: '失败', details: '详情', queued: '排队', working: '执行中', jumpToMessage: '跳转', viewImage: '查看图片', downloadImage: '下载图片' } as unknown as ChatViewProps['labels'];
const base = { labels, demo: false, running: false, queued: 0, onJumpToMessage: () => {}, onEditUserMessage: () => {} } as unknown as ChatViewProps;

// 100 轮对话：首屏假设载入 100 条消息（够建 100 turn），earlierTotal=1000 表示盘上共 1000 turn
function manyTurns(count: number) {
  const branch: any[] = [];
  for (let i = 0; i < count; i += 1) {
    branch.push({ id: `p-u${i}`, type: 'message', timestamp: new Date(1000 + i).toISOString(), message: { role: 'user', content: `q${i}` } });
    branch.push({ id: `p-a${i}`, type: 'message', timestamp: new Date(1001 + i).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: `a${i}` }] } });
  }
  return historyToMessages(branch);
}

describe('history paging contract (tail first screen + seamless load-earlier)', () => {
  it('shows the load-earlier button with the real remaining count when the loaded range is exhausted', () => {
    const onLoadEarlier = vi.fn();
    const html = renderToStaticMarkup(createElement(ChatView, { ...base, messages: manyTurns(100), onLoadEarlier, earlierTotal: 1000 } as unknown as ChatViewProps));
    // 已载入 100 turn，盘上 1000 ⇒ 按钮显示「还有 900 轮」（不消失、不谎报）
    expect(html).toContain('更早的消息');
    expect(html).toContain('展开更早的消息');
  });

  it('hides the button when everything on disk is already loaded', () => {
    const html = renderToStaticMarkup(createElement(ChatView, { ...base, messages: manyTurns(100), earlierTotal: 120 } as unknown as ChatViewProps));
    expect(html).toContain('展开更早的消息'); // 窗口按钮照常
  });

  it('disables the button and shows a loading label while paging', () => {
    const html = renderToStaticMarkup(createElement(ChatView, { ...base, messages: manyTurns(100), onLoadEarlier: () => {}, earlierLoading: true, earlierTotal: 1000 } as unknown as ChatViewProps));
    expect(html).toContain('正在载入更早的消息');
    expect(html).toMatch(/disabled/);
  });

  it('keeps the in-range window button bounded by renderLimit (existing behavior)', () => {
    const html = renderToStaticMarkup(createElement(ChatView, { ...base, messages: manyTurns(100) } as unknown as ChatViewProps));
    // 无 earlierTotal（会话未被截断）：不显示补拉按钮；窗口按钮仍按已载入条数显示
    expect(html).toContain('展开更早的消息');
  });
});
