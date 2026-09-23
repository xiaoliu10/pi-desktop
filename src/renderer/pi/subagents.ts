import { createContext } from 'react';
import type { ChatMessage, ToolPart } from '../replica/contracts';
import { executionTurns } from '../replica/chat/execution';
export const SubagentNavigation = createContext<((callId?:string)=>void)|undefined>(undefined);
export type ChildState='running'|'queued'|'completed'|'failed'|'interrupted'|'unknown'|'skipped';
export interface SubagentChild {id:string;callId:string;agent:string;task:string;mode:string;status:ChildState;model?:string;messages:Record<string,unknown>[];error?:string;tokens?:number;turns?:number;cost?:number}
const obj=(x:unknown):Record<string,any>|undefined=>x&&typeof x==='object'&&!Array.isArray(x)?x as Record<string,any>:undefined;
const text=(x:unknown)=>typeof x==='string'?x:'';
/** Versioned boundary for pi 0.86's official example. Other plugin protocols must opt in separately. */
export function officialSubagentDetails(part:ToolPart) {
 const d=obj(part.resultDetails);
 return part.tool==='subagent'&&d&&['single','parallel','chain'].includes(d.mode)&&['user','project','both'].includes(d.agentScope)&&'projectAgentsDir' in d&&Array.isArray(d.results)?d:undefined;
}
export function projectSubagents(messages:ChatMessage[],parentRunning:boolean):SubagentChild[] {
 const children:SubagentChild[]=[];
 for(const turn of executionTurns(messages)) {
  if(turn.role!=='assistant')continue;
  for(const part of turn.steps) {
   if(part.kind!=='tool')continue;
   const d=officialSubagentDetails(part);if(!d)continue;
   const callId=part.callId||part.id;
   let args:Record<string,any>={};try{args=obj(JSON.parse(part.argumentsText||'{}'))??{};}catch{}
   const requested=d.mode==='chain'?args.chain:d.mode==='parallel'?args.tasks:undefined;
   const size=Math.max(d.results.length,Array.isArray(requested)?requested.length:0);
   for(let i=0;i<size;i++) {
    const r=obj(d.results[i]),request=obj(requested?.[i]);
    const terminal=part.phase==='result'&&part.resultDetailsFinal!==false;
    let status:ChildState;
    if(!r)status=terminal?'skipped':parentRunning?'queued':'unknown';
    else if(part.phase==='result'&&part.resultDetailsFinal===false)status=part.status==='error'?'interrupted':'unknown';
    else if(r.stopReason==='aborted')status='interrupted';
    else if(r.stopReason==='error'||r.errorMessage||(typeof r.exitCode==='number'&&r.exitCode>0))status='failed';
    else if(terminal)status=r.exitCode===0?'completed':part.status==='error'?'interrupted':'unknown';
    else if(d.mode==='chain'&&i<d.results.length-1)status='completed';
    else status=parentRunning?(r.exitCode===-1&&!r.messages?.length?'queued':'running'):'unknown';
    const usage=obj(r?.usage);
    children.push({id:`${callId}:${i}`,callId,mode:d.mode,agent:text(r?.agent)||text(request?.agent)||'子代理',task:text(r?.task)||text(request?.task),status,model:text(r?.model)||undefined,
      messages:Array.isArray(r?.messages)?r.messages.filter((m:unknown)=>obj(m)):[],error:text(r?.errorMessage)||text(r?.stderr)||undefined,
      tokens:usage&&typeof usage.input==='number'&&typeof usage.output==='number'?usage.input+usage.output+(usage.cacheRead||0)+(usage.cacheWrite||0):undefined,
      turns:typeof usage?.turns==='number'?usage.turns:undefined,cost:typeof usage?.cost==='number'?usage.cost:undefined});
   }
  }
 }
 return children;
}
