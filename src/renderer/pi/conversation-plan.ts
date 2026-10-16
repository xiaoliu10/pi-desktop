import type { ChatMessage } from '../replica/contracts';
import type { PlanItem } from '../../shared/conversation-status';

/**
 * 任务清单 = **最近一轮任务**的 desktop_update_plan 结果。
 *
 * 一个会话会跨多个任务（尤其是长期会话），而清单只描述「当前这一轮」。
 * 早先的实现扫全会话历史，返回最后一次成功的 plan —— 用户切回几天前
 * 开过、之后又跑过别的任务的会话时，面板会显示一个跟当前上下文无关的
 * 旧计划（已复现：375 条 plan 记录的会话显示 09-29 的清单）。
 *
 * 轮次边界用最后一条**用户**消息划分：pi 的助手消息永远跟在一个用户消息
 * （或 steer/followUp 投影）之后，属于同一轮。因此只在该边界之后扫描，
 * 上一轮结束后的旧 plan 不再占位。同轮内仍按「最后一次成功结果」取值，
 * 保留 progress→result 的收敛语义（原契约不变）。
 */
export function conversationPlan(messages: ChatMessage[]): PlanItem[] {
  let start = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') { start = index + 1; break; }
    start = index; // 没有用户消息（纯工具续跑）时退回整段，保持可用
  }
  const saved = new Set(messages.slice(start).flatMap(m => m.parts).filter(p => p.kind === 'tool' && p.phase === 'result').map(p => (p.kind === 'tool' ? p.callId : undefined)).filter(Boolean));
  let plan: PlanItem[] = [];
  for (let index = start; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) continue;
    for (const part of message.parts) {
      if (part.kind !== 'tool' || part.tool !== 'desktop_update_plan' || part.status !== 'done' || part.phase === 'call' || (part.phase === 'progress' && saved.has(part.callId))) continue;
      try {
        const value = JSON.parse((part.detailLines || []).join('\n')).plan;
        if (Array.isArray(value) && value.length <= 30 && value.every(p => p && typeof p.step === 'string' && ['pending', 'in_progress', 'completed'].includes(p.status))) plan = value;
      } catch { /* Partial streaming results never replace the last accepted checklist. */ }
    }
  }
  return plan;
}
