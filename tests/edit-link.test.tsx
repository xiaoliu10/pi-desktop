import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ToolCard } from '../src/renderer/replica/chat/ChatView';
import type { ToolPart, ChatViewProps } from '../src/renderer/replica/contracts';
const labels = { you:'你', assistant:'助手', simulatedRun:'模拟', toolRunning:'运行中', toolDone:'完成', toolError:'出错', working:'工作中', queued:'已排队', jumpToMessage:'跳转' } as unknown as ChatViewProps['labels'];
const onOpenToolFile = (p:ToolPart)=>{};
it('renders file-link for done edit', () => {
  const part: ToolPart = { kind:'tool', id:'e1', callId:'c1', tool:'edit', phase:'result', status:'done', argumentsText: JSON.stringify({path:'src/a.tsx', edits:[{oldText:'x',newText:'y'}]}), summary:'' };
  const html = renderToStaticMarkup(createElement(ToolCard, { part, labels, onOpenToolFile }));
  expect(html).toContain('pi-tool__file-link');
});
