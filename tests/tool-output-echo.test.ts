import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ToolCard } from '../src/renderer/replica/chat/ChatView';
import type { ToolPart, ChatViewProps } from '../src/renderer/replica/contracts';

const labels = { you: '你', assistant: '助手', simulatedRun: '模拟', toolRunning: '运行中', toolDone: '完成', toolError: '出错', working: '工作中', queued: '已排队', jumpToMessage: '跳转' } as unknown as ChatViewProps['labels'];

// pi 的 bash 工具把结果存成 `$ <命令>\n<真实 stdout>`：首行是命令回显，stdout 跟在后面。
const bashResult = (detail: string, callId = 'c1'): ToolPart => ({
  kind: 'tool', id: 't1', callId, tool: 'bash', phase: 'result', status: 'done',
  argumentsText: JSON.stringify({ command: 'tsc -p tsconfig.json --noEmit' }, null, 2),
  summary: '', detailLines: [detail],
});

describe('tool output strips the bash command echo', () => {
  it('shows only real stdout, not the `$ command` echo line (command is already in the summary)', () => {
    const part = bashResult('$ tsc -p tsconfig.json --noEmit\n\n Test Files 30 passed | 1 skipped (32)\n      Tests 164 passed | 1 skipped (174)\n');
    const html = renderToStaticMarkup(createElement(ToolCard, { part, labels }));
    expect(html).toContain('Test Files 30 passed');
    expect(html.split('class="pi-terminal__output"')[1]).not.toContain('$ tsc');
    expect(html.match(/\$<\/span> tsc/g)).toHaveLength(1);
  });
  it('shows 无文本输出 when the command produced no stdout (clean run)', () => {
    const part = bashResult('$ tsc -p tsconfig.json --noEmit\n');
    const html = renderToStaticMarkup(createElement(ToolCard, { part, labels }));
    expect(html).toContain('无文本输出');
    expect(html.split('class="pi-terminal__output"')[1]).not.toContain('$ tsc');
    expect(html.match(/\$<\/span> tsc/g)).toHaveLength(1);
  });
  it('does not strip a leading $ line for non-shell tools (e.g. read)', () => {
    const part: ToolPart = { kind: 'tool', id: 't2', callId: 'c2', tool: 'read', phase: 'result', status: 'done', argumentsText: '{"path":"a.ts"}', summary: '', detailLines: ['export const x = 1;'] };
    const html = renderToStaticMarkup(createElement(ToolCard, { part, labels }));
    expect(html).toContain('export const x = 1');
  });
});
