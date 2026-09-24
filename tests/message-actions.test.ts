import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TurnArticle } from '../src/renderer/replica/chat/ChatView';
import type { ChatTurn, ChatViewProps } from '../src/renderer/replica/contracts';
const labels = { you:'你', assistant:'助手', simulatedRun:'模拟', toolRunning:'运行中', toolDone:'完成', toolError:'出错', working:'工作中', queued:'已排队', copyMessage:'复制', copied:'已复制', editMessage:'编辑并重发', resend:'重发', cancel:'取消', viewImage:'查看原图', downloadImage:'下载图片', close:'关闭', details:'详情' } as unknown as ChatViewProps['labels'];
const userTurn = {
  id: 'entry-1', role: 'user', messageIds: ['entry-1'], startedAt: 1,
  segments: [{ kind: 'text', parts: [{ kind: 'text', id: 'entry-1-t', text: '帮我修这个 bug' }] }],
  steps: [], answer: [{ kind: 'text', id: 'entry-1-t', text: '帮我修这个 bug' }],
} as unknown as ChatTurn;
describe('已发送用户消息的复制/编辑动作', () => {
  it('hover 动作行包含复制与编辑（提供 onEditUser 时）', () => {
    const html = renderToStaticMarkup(createElement(TurnArticle, { m: userTurn, liveTurn: false, labels, onEditUser: () => {} }));
    expect(html).toContain('pi-msg__actions');
    expect(html).toContain('复制');
    expect(html).toContain('编辑并重发');
  });
  it('父任务运行中（不传 onEditUser）只剩复制，无编辑入口', () => {
    const html = renderToStaticMarkup(createElement(TurnArticle, { m: userTurn, liveTurn: false, labels }));
    expect(html).toContain('复制');
    expect(html).not.toContain('编辑并重发');
  });
  it('助手轮不渲染动作行', () => {
    const turn = { id: 'execution-entry-1', role: 'assistant', messageIds: [], segments: [], steps: [], answer: [] } as unknown as ChatTurn;
    const html = renderToStaticMarkup(createElement(TurnArticle, { m: turn, liveTurn: false, labels, onEditUser: () => {} }));
    expect(html).not.toContain('pi-msg__actions');
  });
  it('已发送图片渲染为可点击放大按钮（灯箱默认关闭）', () => {
    const turn = {
      id: 'entry-2', role: 'user', messageIds: ['entry-2'],
      segments: [{ kind: 'text', parts: [{ kind: 'image', id: 'entry-2-i', data: 'QUJD', mimeType: 'image/png' }] }],
      steps: [], answer: [{ kind: 'image', id: 'entry-2-i', data: 'QUJD', mimeType: 'image/png' }],
    } as unknown as ChatTurn;
    const html = renderToStaticMarkup(createElement(TurnArticle, { m: turn, liveTurn: false, labels, onDownloadImage: () => {} }));
    expect(html).toContain('pi-msg__imagebtn');
    expect(html).toContain('查看原图');
    expect(html).not.toContain('pi-lightbox'); // 灯箱只在点击后出现
  });
});
