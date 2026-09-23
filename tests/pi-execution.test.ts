import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { executionTurns } from '../src/renderer/replica/chat/execution';
import { ChatView } from '../src/renderer/replica/chat/ChatView';
import { conversationMessages, historyToMessages, liveToMessages } from '../src/renderer/pi/adapter';
import type { PiEntry } from '../src/shared/pi';
import type { ToolPart } from '../src/renderer/replica/contracts';
const branch: PiEntry[] = [
  { id:'u1',type:'message',message:{role:'user',content:'修复问题'} },
  { id:'a1',type:'message',message:{role:'assistant',timestamp:10,content:[{type:'thinking',thinking:'先检查相关源码。'},{type:'text',text:'我先读取文件。'},{type:'toolCall',id:'call-1',name:'read',arguments:{path:'app.ts'}}]} },
  { id:'r1',type:'message',message:{role:'toolResult',toolCallId:'call-1',toolName:'read',content:[{type:'text',text:'file contents'}]} },
  { id:'a2',type:'message',message:{role:'assistant',timestamp:20,content:[{type:'thinking',thinking:'发现了问题，接下来执行检查。'},{type:'toolCall',id:'call-2',name:'bash',arguments:{command:'pnpm test'}}]} },
  { id:'r2',type:'message',message:{role:'toolResult',toolCallId:'call-2',toolName:'bash',isError:true,content:'test failed'} },
  { id:'a3',type:'message',message:{role:'assistant',timestamp:30,content:[{type:'text',text:'最终回复保持直接可见。'}]} },
];
describe('nested execution transcript',()=>{
  it('pairs requests and results once, preserves reasoning and ordering, keeps final reply outside',()=>{
    const turns=executionTurns(historyToMessages(branch));expect(turns).toHaveLength(2);
    const turn=turns[1];expect(turn.steps.map(p=>p.kind)).toEqual(['thinking','tool','thinking','tool']);
    const tools=turn.steps.filter(p=>p.kind==='tool') as ToolPart[];expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({callId:'call-1',phase:'result',detailLines:['file contents'],argumentsText:JSON.stringify({path:'app.ts'},null,2)});
    expect(tools[1].status).toBe('error');
    // 过程叙述收进思考块，只有结论直接可见。
    expect(turn.answer.map(p=>(p as {text:string}).text)).toEqual(['最终回复保持直接可见。']);
    expect((turn.steps[0] as {text:string}).text).toContain('我先读取文件。');
  });
  it('never merges across user turns or merges calls by name alone',()=>{
    const more=[...branch,{id:'u2',type:'message',message:{role:'user',content:'再试一次'}},{id:'a4',type:'message',message:{role:'assistant',content:[{type:'toolCall',id:'call-1',name:'read',arguments:{path:'other'}}]}}];
    const turns=executionTurns(historyToMessages(more));expect(turns).toHaveLength(4);expect(turns[1].id).not.toBe(turns[3].id);expect(turns[3].steps).toHaveLength(1);
  });
  it('deduplicates persisted streaming messages and prefers results over late progress',()=>{
    const messages=conversationMessages(branch,{'10':branch[1].message!,'30':branch[5].message!},[{toolCallId:'call-2',name:'bash',text:'old partial',status:'running'}]);
    const turn=executionTurns(messages)[1];expect(turn.steps.filter(p=>p.kind==='thinking')).toHaveLength(2);
    const tool=turn.steps.find(p=>p.kind==='tool'&&p.callId==='call-2') as ToolPart;expect(tool.status).toBe('error');expect(tool.detailLines).toEqual(['test failed']);expect(turn.answer.map(p=>p.kind)).toEqual(['text']);
  });
  it('keeps turn and tool ids stable when a streaming call is saved',()=>{
    const streamed=executionTurns([...historyToMessages(branch.slice(0,1)),...liveToMessages({'10':branch[1].message!},[{toolCallId:'call-1',name:'read',text:'partial',status:'running'}])])[1];
    const saved=executionTurns(historyToMessages(branch.slice(0,3)))[1];expect(streamed.id).toBe(saved.id);expect(streamed.steps.find(p=>p.kind==='tool')?.id).toBe(saved.steps.find(p=>p.kind==='tool')?.id);expect(streamed.steps[0].id).toBe(saved.steps[0].id);
  });
  it('orders segments chronologically: an interim conclusion splits the tool trace',()=>{
    // tools → text (conclusion) → more tools → final text
    const turns=executionTurns(historyToMessages(branch));
    const turn=turns[1];
    expect(turn.segments.map((s)=>s.kind)).toEqual(['steps','text']);
    expect(turn.segments[0].parts[0]).toMatchObject({kind:'thinking'});
    expect((turn.segments[0].parts[0] as {text:string}).text).toContain('我先读取文件。');
    expect(turn.segments[1].parts[0]).toMatchObject({kind:'text',text:'最终回复保持直接可见。'});
    // the merged group still holds the failing bash call
    expect(turn.segments[0].parts.some((p)=>p.kind==='tool'&&(p as ToolPart).status==='error')).toBe(true);
  });
  it('renders two collapsed disclosure levels with visible failure summary and normal text-only responses',()=>{
    const labels={you:'你',assistant:'pi',simulatedRun:'演示',toolRunning:'运行中',toolDone:'完成',toolError:'失败',details:'详情',queued:'排队',working:'执行中'};
    const markup=renderToStaticMarkup(createElement(ChatView, {messages:historyToMessages(branch),running:false,queued:0,demo:false,labels,onJumpToMessage:()=>{}}));
    expect(markup).not.toContain('2 次工具调用');expect(markup).not.toContain('2 段思考');expect(markup).toContain('1 项失败');expect(markup).not.toMatch(/<details[^>]*\sopen(?:[=>\s])/);expect(markup).toContain('调用参数');expect(markup).toContain('执行输出');
    const plain=executionTurns([{id:'hello',role:'assistant',parts:[{id:'text',kind:'text',text:'Hi'}]}])[0];expect(plain.steps).toEqual([]);expect(plain.answer[0].kind).toBe('text');
  });
});

describe('execution elapsed time', () => {
  it('uses persisted completion time instead of assistant request time and isolates turns', () => {
    const messages = historyToMessages([
      { type: 'message', id: 'u1', timestamp: '2026-09-20T00:00:00Z', message: { role: 'user', content: 'first' } },
      { type: 'message', id: 'a1', timestamp: '2026-09-20T00:01:05Z', message: { role: 'assistant', timestamp: Date.parse('2026-09-20T00:00:01Z'), content: 'done' } },
      { type: 'message', id: 'u2', timestamp: '2026-09-20T01:00:00Z', message: { role: 'user', content: 'second' } },
      { type: 'message', id: 'a2', timestamp: '2026-09-20T01:00:03Z', message: { role: 'assistant', content: 'done' } },
    ]);
    const turns = executionTurns(messages);
    expect(turns[1].endedAt! - turns[1].startedAt!).toBe(65000);
    expect(turns[3].endedAt! - turns[3].startedAt!).toBe(3000);
    const html = renderToStaticMarkup(createElement(ChatView, { messages, running: false, queued: 0, demo: false, labels: { you: '你' } as any, onJumpToMessage: () => {} }));
    expect(html).toContain('1分钟 5秒');
    expect(html).toContain('用时');
    expect(html).toContain('3秒');
  });
  it('does not fabricate elapsed time for legacy messages without timestamps', () => {
    const html = renderToStaticMarkup(createElement(ChatView, { messages: [{ id: 'u', role: 'user', parts: [] }, { id: 'a', role: 'assistant', parts: [{ kind: 'text', id: 't', text: 'done' }] }], running: false, queued: 0, demo: false, labels: { you: '你' } as any, onJumpToMessage: () => {} }));
    expect(html).not.toContain('用时');
  });
});

it('opens only the active execution group while working and collapses it on completion', () => {
 const messages=historyToMessages([...branch,
  {id:'u2',type:'message',message:{role:'user',content:'continue'}},
  {id:'a4',type:'message',message:{role:'assistant',content:[{type:'toolCall',id:'next',name:'read',arguments:{path:'next.ts'}}]}}
 ]);
 const render=(running:boolean)=>renderToStaticMarkup(createElement(ChatView,{messages,running,queued:0,demo:false,labels:{you:'你'} as any,onJumpToMessage:()=>{}}));
 const active=render(true);
 expect(active.match(/<details[^>]*\sopen=""/g)).toHaveLength(1);
 expect(active).toMatch(/<details open="" class="pi-execution pi-execution--running/);
 expect(render(false)).not.toMatch(/<details[^>]*\sopen=""/);
});

it('marks a running group as bold thinking while the model streams reasoning', () => {
 const messages=historyToMessages([...branch,
  {id:'u2',type:'message',message:{role:'user',content:'继续'}},
  {id:'a5',type:'message',message:{role:'assistant',content:[{type:'thinking',thinking:'分析问题…'}]}}
 ]);
 const render=(running:boolean)=>renderToStaticMarkup(createElement(ChatView,{messages,running,queued:0,demo:false,labels:{you:'你'} as any,onJumpToMessage:()=>{}}));
 expect(render(true)).toContain('正在思考');
 expect(render(false)).not.toContain('正在思考');
});
