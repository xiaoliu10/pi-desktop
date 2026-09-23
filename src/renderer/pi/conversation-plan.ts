import type { ChatMessage } from '../replica/contracts';
import type { PlanItem } from '../../shared/conversation-status';
/** Only successful tool results are authoritative; calls may fail or be cancelled. */
export function conversationPlan(messages: ChatMessage[]): PlanItem[] {
  let plan: PlanItem[] = [];
  const saved = new Set(messages.flatMap(m=>m.parts).filter(p=>p.kind==='tool' && p.phase==='result').map(p=>p.kind==='tool'?p.callId:undefined).filter(Boolean));
  for(const message of messages) for(const part of message.parts) {
    if(part.kind !== 'tool' || part.tool !== 'desktop_update_plan' || part.status !== 'done' || part.phase === 'call' || (part.phase === 'progress' && saved.has(part.callId))) continue;
    try {
      const value = JSON.parse((part.detailLines || []).join('\n')).plan;
      if(Array.isArray(value) && value.length<=30 && value.every(p=>p && typeof p.step==='string' && ['pending','in_progress','completed'].includes(p.status))) plan=value;
    } catch { /* Partial streaming results never replace the last accepted checklist. */ }
  }
  return plan;
}
