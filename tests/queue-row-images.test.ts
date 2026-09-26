import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Composer } from '../src/renderer/replica/chat/ChatView';
import { ContextChips } from '../src/renderer/pi/ComposerTools';
import type { PiImage } from '../src/shared/composer';

const imgA: PiImage = { type: 'image', mimeType: 'image/png', data: 'aGk=' };
const labels = { queueNow: '立即', queueEdit: '编辑', queueRemove: '删除', send: '发送', stop: '停止' } as any;

describe('queue thumbnails + composer image chips (DOM)', () => {
  it('renders image thumbnails on queued rows when the queue entry carries images', () => {
    const html = renderToStaticMarkup(createElement(Composer, {
      sessionActive: true, modelId: 'm', modelGroups: [], reasoning: 'off', agentMode: 'agent', permissionMode: 'ask',
      slashCommands: [], files: [], running: true, queued: 1, demo: false, labels,
      queue: [{ text: '看看这张图', behavior: 'followUp', images: [imgA] }],
      onSend: () => {}, onStop: () => {}, onPickModel: () => {}, onPickReasoning: () => {}, onPickAgentMode: () => {}, onPickPermission: () => {},
    } as any));
    expect(html).toContain('pi-prompt-queue__thumb');
    expect(html).toContain(`data:image/png;base64,${imgA.data}`);
    expect(html).toContain('看看这张图');
  });

  it('omits the thumbnail slot for text-only queued entries (no mismatched image leaks)', () => {
    const html = renderToStaticMarkup(createElement(Composer, {
      sessionActive: true, modelId: 'm', modelGroups: [], reasoning: 'off', agentMode: 'agent', permissionMode: 'ask',
      slashCommands: [], files: [], running: true, queued: 1, demo: false, labels,
      queue: [{ text: '纯文本排队', behavior: 'followUp' }],
      onSend: () => {}, onStop: () => {}, onPickModel: () => {}, onPickReasoning: () => {}, onPickAgentMode: () => {}, onPickPermission: () => {},
    } as any));
    expect(html).not.toContain('pi-prompt-queue__thumb');
    expect(html).toContain('纯文本排队');
  });

  it('renders recalled images as composer chips with a data-url preview', () => {
    // queueRecall 载入输入框的产物：kind=image 的 ContextItem（与正常贴图附件同一路径）
    const html = renderToStaticMarkup(createElement(ContextChips, {
      items: [{ id: 'recall-img-1-0', name: '图片 1', path: '', kind: 'image' as const, text: '', image: imgA }],
      remove: () => {},
    }));
    expect(html).toContain('pi-attachment-thumbnail');
    expect(html).toContain(`data:image/png;base64,${imgA.data}`);
    expect(html).toContain('双击放大预览');
  });
});
