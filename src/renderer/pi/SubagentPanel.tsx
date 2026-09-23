import { useEffect, useRef, useState } from 'react';
import type { SubagentChild,ChildState } from './subagents';
import { ChatMarkdown } from '../replica/chat/ChatView';
import { Icon } from '../replica/Icons';
import './subagents.css';
const labels:Record<ChildState,string>={running:'执行中 / 等待汇总',queued:'等待执行',completed:'已完成',failed:'失败',interrupted:'已中断',unknown:'状态未确认',skipped:'未执行'};
function Transcript({messages}:{messages:SubagentChild['messages']}) {
 return <>{messages.map((m,i)=><article className="pi-subagent-message" key={i}><small>{m.role==='assistant'?'子代理':m.role==='toolResult'?String(m.toolName||'工具结果'):'任务'}</small>{typeof m.content==='string'?<ChatMarkdown text={m.content}/>:Array.isArray(m.content)?m.content.map((b,j)=>{
  if(!b||typeof b!=='object')return null;
  if(b.type==='text'&&typeof b.text==='string')return <ChatMarkdown key={j} text={b.text}/>;
  if(b.type==='thinking')return <details key={j}><summary>思考</summary><pre>{String(b.thinking||'')}</pre></details>;
  if(b.type==='toolCall')return <details key={j}><summary>工具 · {String(b.name||'')}</summary><pre>{JSON.stringify(b.arguments,null,2)}</pre></details>;
  return null;
 }):null}</article>)}</>;
}
export function SubagentPanel({children,initialCall,onClose,onStop,parentRunning}:{children:SubagentChild[];initialCall?:string;onClose:()=>void;onStop:()=>void;parentRunning:boolean}) {
 const [selected,setSelected]=useState<string|undefined>(()=>children.find(c=>c.callId===initialCall)?.id);
 const [filter,setFilter]=useState('all');
 const [limit,setLimit]=useState(30);
 const active=children.find(c=>c.id===selected);
 const transcript=useRef<HTMLDivElement>(null),follow=useRef(true);
 useEffect(()=>{follow.current=true;},[selected]);
 useEffect(()=>{if(follow.current&&transcript.current)transcript.current.scrollTop=transcript.current.scrollHeight;},[selected,active?.messages]);
 const list=children.filter(c=>filter==='all'||(filter==='running'?['running','queued'].includes(c.status):!['running','queued'].includes(c.status)));
 return <aside className="pi-subagents" aria-label="子代理监控">
  <header><strong>{active?'子代理详情':'子代理任务'}</strong><button className="pi-iconbtn" aria-label="关闭子代理面板" onClick={onClose}><Icon name="x" size={16}/></button></header>
  {active?<>
    <button className="pi-btn pi-btn--ghost" onClick={()=>setSelected(undefined)}>‹ 返回任务目录</button>
    <div className="pi-subagents__meta"><h3>{active.agent}</h3><span data-status={active.status}>{labels[active.status]}</span><p>{active.task}</p><small>{active.model||'模型未报告'} · {active.mode}</small><p>{active.tokens!==undefined?`${active.tokens.toLocaleString()} tokens`:'用量未报告'}{active.turns!==undefined?` · ${active.turns} 轮`:''}{active.cost!==undefined?` · $${active.cost.toFixed(4)}`:''}</p></div>
    <div className="pi-subagents__transcript" ref={transcript} onScroll={e=>{const el=e.currentTarget;follow.current=el.scrollHeight-el.clientHeight-el.scrollTop<48;}}>{active.error&&<p role="alert">{active.error}</p>}<Transcript messages={active.messages}/>{!active.messages.length&&<p>插件尚未报告消息。</p>}</div>
  </>:<>
    <nav aria-label="子代理状态筛选">{[['all','全部'],['running','进行中'],['ended','已结束 / 未确认']].map(([value,label])=><button key={value} aria-pressed={filter===value} onClick={()=>{setFilter(value);setLimit(30);}}>{label}</button>)}</nav>
    <div className="pi-subagents__list">{list.slice(0,limit).map(c=><button className="pi-subagent-row" key={c.id} onClick={()=>setSelected(c.id)}><strong>{c.agent}</strong><span data-status={c.status}>{labels[c.status]}</span><p>{c.task}</p></button>)}{list.length>limit&&<button className="pi-btn" onClick={()=>setLimit(n=>n+30)}>加载更多</button>}{!list.length&&<p>暂无匹配的子代理记录。</p>}</div>
  </>}
  <footer><small>适配：pi 0.86 官方 subagent 扩展。只读展示插件报告的消息；历史记录缺失时不会推测运行结果。</small>{parentRunning&&children.some(c=>['running','queued'].includes(c.status))&&<button className="pi-btn pi-btn--outline" onClick={onStop}>停止主任务及其子代理</button>}</footer>
 </aside>;
}
