import { createContext } from 'react';
import type { ChatMessage, ToolPart } from '../replica/contracts';
import { executionTurns, type ChatTurn } from '../replica/chat/execution';
import { historyToMessages } from './adapter';
import type { PiEntry } from '../../shared/pi';
import { findAdapter } from './subagent-registry';

/**
 * 子代理转录 → 主对话同构轮次：插件上报的 messages 就是 pi 消息对象，
 * 包装成 PiEntry 走同一套 historyToMessages + executionTurns，
 * 从而直接复用 TurnArticle/ToolCard/ExecutionNote 渲染（与主对话完全一致）。
 * turnKey 参与消息 id，避免多个子代理的轮次缓存互相串扰。
 */
export function subagentTranscriptTurns(messages: SubagentChild['messages'], turnKey: string): ChatTurn[] {
  const entries = messages.map((message, i) => ({ type: 'message', id: `${turnKey}:${i}`, message }) as unknown as PiEntry);
  return executionTurns(historyToMessages(entries));
}

export const SubagentNavigation = createContext<((callId?: string) => void) | undefined>(undefined);
export type ChildState = 'running' | 'queued' | 'completed' | 'failed' | 'interrupted' | 'unknown' | 'skipped' | 'recovered';
export interface SubagentChild { id: string; callId: string; agent: string; task: string; mode: string; status: ChildState; model?: string; messages: Record<string, unknown>[]; error?: string; tokens?: number; turns?: number; cost?: number; recovered?: boolean }

const obj = (x: unknown): Record<string, any> | undefined => x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, any> : undefined;
const text = (x: unknown): string => typeof x === 'string' ? x : '';

/** Backward-compatible check: does this tool part have subagent details?
 *  Delegates to the adapter registry's detect logic. */
export function officialSubagentDetails(part: ToolPart) {
  const adapter = findAdapter(part);
  return adapter ? obj(part.resultDetails) : undefined;
}

export interface RecoveredSubagent { callId: string; status: string; details?: unknown; error?: string; startedAt?: number; updatedAt?: number }

function parseRecoveredDetails(d: unknown) {
  const details = obj(d);
  if (!details || !['single', 'parallel', 'chain'].includes(details.mode) || !Array.isArray(details.results)) return null;
  return details;
}

export function projectSubagents(messages: ChatMessage[], parentRunning: boolean, recovered?: RecoveredSubagent[]): SubagentChild[] {
  const children: SubagentChild[] = [];
  const seenCallIds = new Set<string>();

  for (const turn of executionTurns(messages)) {
    if (turn.role !== 'assistant') continue;
    for (const part of turn.steps) {
      if (part.kind !== 'tool') continue;
      // Use the adapter registry: find the first adapter that detects this part's format.
      const adapter = findAdapter(part);
      if (!adapter) continue;
      seenCallIds.add(part.callId || part.id);
      children.push(...adapter.parse(part, parentRunning));
    }
  }

  // 合并磁盘恢复的子代理：父进程崩溃后扩展持久化的最后快照。
  if (recovered && recovered.length) {
    for (const rec of recovered) {
      if (seenCallIds.has(rec.callId)) continue;
      const d = parseRecoveredDetails(rec.details);
      if (!d) {
        children.push({ id: `${rec.callId}:0`, callId: rec.callId, mode: 'single', agent: '子代理', task: rec.error || '（父任务已重启，进度已从磁盘恢复）', status: 'recovered', messages: [], error: rec.error });
        continue;
      }
      for (let i = 0; i < d.results.length; i++) {
        const r = obj(d.results[i]);
        const usage = obj(r?.usage);
        children.push({
          id: `${rec.callId}:${i}`, callId: rec.callId, mode: d.mode,
          agent: text(r?.agent) || '子代理', task: text(r?.task),
          status: 'recovered', model: text(r?.model) || undefined,
          messages: Array.isArray(r?.messages) ? r.messages.filter((m: unknown) => obj(m)) : [],
          error: text(r?.errorMessage) || text(r?.stderr) || rec.error,
          tokens: usage && typeof usage.input === 'number' && typeof usage.output === 'number' ? usage.input + usage.output + (usage.cacheRead || 0) + (usage.cacheWrite || 0) : undefined,
          turns: typeof usage?.turns === 'number' ? usage.turns : undefined,
          cost: typeof usage?.cost === 'number' ? usage.cost : undefined,
          recovered: true,
        });
      }
    }
  }

  return children;
}
