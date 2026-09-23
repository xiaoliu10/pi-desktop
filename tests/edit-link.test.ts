import { expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ToolCard } from '../src/renderer/replica/chat/ChatView';
import { liveToMessages } from '../src/renderer/pi/adapter';
import type { ToolPart, ChatViewProps } from '../src/renderer/replica/contracts';
const labels = { you:'你', assistant:'助手', simulatedRun:'模拟', toolRunning:'运行中', toolDone:'完成', toolError:'出错', working:'工作中', queued:'已排队', jumpToMessage:'跳转' } as unknown as ChatViewProps['labels'];
const onOpenToolFile = (_p:ToolPart)=>{};

it('renders file-link + line stat for a done edit with edits[]', () => {
  const part: ToolPart = { kind:'tool', id:'e1', callId:'c1', tool:'edit', phase:'result', status:'done', argumentsText: JSON.stringify({path:'src/a.tsx', edits:[{oldText:'x',newText:'y\nz'}]}), summary:'' };
  const html = renderToStaticMarkup(createElement(ToolCard, { part, labels, onOpenToolFile }));
  expect(html).toContain('pi-tool__file-link');
  expect(html).toContain('+2');
});

it('live toolProgress carries argumentsText so a RUNNING edit still gets the link', () => {
  // handleRpcEvent 把 raw.args 记进 ToolProgress.argumentsText；liveToMessages 映射到部件。
  const msgs = liveToMessages({}, [{ toolCallId:'c2', name:'edit', text:'…', status:'running', phase:'progress', argumentsText: JSON.stringify({path:'src/b.tsx', edits:[{oldText:'a',newText:'b'}]}) }]);
  const part = msgs[0].parts[0] as ToolPart;
  expect(part.argumentsText).toBe(JSON.stringify({path:'src/b.tsx', edits:[{oldText:'a',newText:'b'}]}));
  const html = renderToStaticMarkup(createElement(ToolCard, { part, labels, onOpenToolFile }));
  expect(html).toContain('pi-tool__file-link');
});
