import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ToolCard } from '../src/renderer/replica/chat/ChatView';
import type { ToolPart, ChatViewProps } from '../src/renderer/replica/contracts';

const labels = { you: '你', assistant: '助手', simulatedRun: '模拟', toolRunning: '运行中', toolDone: '完成', toolError: '出错', working: '工作中', queued: '已排队', jumpToMessage: '跳转' } as unknown as ChatViewProps['labels'];

describe('tool summary change stats', () => {
  it('write shows +N from the content line count', () => {
    const part: ToolPart = { kind: 'tool', id: 'w1', callId: 'cw', tool: 'write', phase: 'result', status: 'done', argumentsText: JSON.stringify({ path: 'tests/x.test.ts', content: 'a\nb\nc' }), summary: '' };
    const html = renderToStaticMarkup(createElement(ToolCard, { part, labels }));
    expect(html).toContain('+3');
  });
  it('edit shows +N / −M from the edits array', () => {
    const part: ToolPart = { kind: 'tool', id: 'e1', callId: 'ce', tool: 'edit', phase: 'result', status: 'done', argumentsText: JSON.stringify({ path: 'src/a.ts', edits: [{ oldText: 'p\nq', newText: 'P' }] }), summary: '' };
    const html = renderToStaticMarkup(createElement(ToolCard, { part, labels }));
    expect(html).toContain('−2');
    expect(html).toContain('+1');
  });
  it('bash shows no change stat', () => {
    const part: ToolPart = { kind: 'tool', id: 'b1', callId: 'cb', tool: 'bash', phase: 'result', status: 'done', argumentsText: '{"command":"ls"}', summary: '' };
    const html = renderToStaticMarkup(createElement(ToolCard, { part, labels }));
    expect(html).not.toContain('pi-tool__stat--add');
  });
});
