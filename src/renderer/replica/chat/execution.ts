import type { ChatMessage, MessagePart, ToolPart } from '../contracts';
import { coalesceErrors } from './error-groups';
/** Chronological slice of a turn: tool/thinking runs, or visible text. */
export interface ChatSegment {
  kind: 'steps' | 'text';
  parts: MessagePart[];
}
export interface ChatTurn {
  startedAt?: number;
  endedAt?: number;
  id: string;
  role: 'user' | 'assistant';
  messageIds: string[];
  /** Ordered segments: tools/thinking runs interleaved with visible text. */
  segments: ChatSegment[];
  /** Convenience views over segments (all execution parts / all visible text). */
  steps: MessagePart[];
  answer: MessagePart[];
  simulated?: boolean;
  model?: string;
}
/**
 * One assistant turn per user message, but unlike a flat grouping the parts
 * keep their chronological order: a text conclusion CLOSES the current
 * execution disclosure and later tool calls open a new one AFTER it.
 *
 * Turn objects are identity-cached: streaming events rebuild the messages array
 * many times per second, and ChatView's memoized rows only skip re-render when
 * an unchanged turn keeps its object identity. Signature = member count plus
 * first/last member identity (the tail is what streaming mutates).
 */
const turnCache = new Map<string, { count: number; first: ChatMessage; last: ChatMessage; members?: ChatMessage[]; turn: ChatTurn }>();

export function executionTurns(messages: ChatMessage[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  const groups: { id: string; role: 'user' | 'assistant'; boundary: string; startedAt?: number; members: ChatMessage[] }[] = [];
  let current: (typeof groups)[number] | undefined;
  for (const message of messages) {
    if (message.role === 'user') {
      current = { id: message.id, role: 'user', boundary: message.id, startedAt: message.timestamp, members: [message] };
      groups.push(current);
      continue;
    }
    if (!current || current.role === 'user') {
      current = { id: `execution-${current?.boundary ?? 'initial'}`, role: 'assistant', boundary: current?.boundary ?? 'initial', startedAt: current?.startedAt, members: [] };
      groups.push(current);
    }
    current.members.push(message);
  }
  for (const group of groups) {
    if (group.role === 'user') {
      const message = group.members[0]!;
      const userHit = turnCache.get(group.id);
      if (userHit && userHit.count === 1 && userHit.first === message && userHit.last === message) { turns.push(userHit.turn); continue; }
      const turn: ChatTurn = { id: group.id, role: 'user', messageIds: [message.id], segments: [{ kind: 'text', parts: message.parts }], steps: [], answer: message.parts };
      turnCache.set(group.id, { count: 1, first: message, last: message, turn });
      turns.push(turn);
      continue;
    }
    const first = group.members[0]!;
    const last = group.members[group.members.length - 1]!;
    const hit = turnCache.get(group.id);
    if (hit && hit.count === group.members.length && hit.members?.every((message, index) => message === group.members[index]) && hit.turn.startedAt === group.startedAt) { turns.push(hit.turn); continue; }
    const turn: ChatTurn = { startedAt: group.startedAt, id: group.id, role: 'assistant', messageIds: [], segments: [], steps: [], answer: [], simulated: first.simulated, model: first.model };
    // A successful model response settles earlier failed attempts within THIS user turn.
    // Tool results/partial thinking/empty stream starts are not evidence of recovery.
    let recoveredThrough = -1;
    group.members.forEach((message, index) => { if (message.modelOutcome === 'success') recoveredThrough = index; });
    for (const [index, message] of group.members.entries()) {
      if (message.timestamp !== undefined) turn.endedAt = Math.max(turn.endedAt ?? message.timestamp, message.timestamp);
      turn.messageIds.push(message.id);
      turn.steps.push(...message.parts.filter(part => !(index < recoveredThrough && part.kind === 'error' && part.source === 'model')));
    }
    const flattened: MessagePart[] = [];
    const tools = new Map<string, ToolPart>();
    for (const part of coalesceErrors(turn.steps)) {
      if (part.kind !== 'tool' || !part.callId) { flattened.push(part); continue; }
      const existing = tools.get(part.callId);
      if (!existing) {
        const copy = { ...part, id: `tool-${part.callId}` };
        tools.set(part.callId, copy); flattened.push(copy);
      } else {
        // Saved results win over delayed streaming progress. Keep original input alongside output.
        const fallbackDetails=existing.resultDetails??part.resultDetails;
        const input = existing.argumentsText || part.argumentsText;
        const summary = existing.argumentsText ? existing.summary : part.argumentsText ? part.summary : part.summary || existing.summary;
        const toolName = existing.tool !== 'tool' ? existing.tool : part.tool;
        if (existing.phase !== 'result' && part.phase !== 'call') Object.assign(existing, part, { id: `tool-${part.callId}` });
        if(existing.resultDetails===undefined&&fallbackDetails!==undefined){existing.resultDetails=fallbackDetails;existing.resultDetailsFinal=false;}
        existing.argumentsText = input;
        existing.summary = summary;
        existing.tool = toolName;
      }
    }
    // 过程文本保持时间线原位（ZCode 同款）：最后一个工具/思考之前的文本是过程叙述，
    // 留在执行组内以段落（pi-execution__commentary）渲染；之后的文本才是结论，直接可见。
    // （曾把过程文本折进思考块——流式时文字还会从答案位跳进思考行；用户要求像 ZCode 一样显示过程叙述）
    // 例外：最后一个 text 恒为结论（用户要求：任务结束后结果直接可见，不折进过程块）——
    // agent 常在总结后又跑收尾工具，若严格按「最后一个工具之后」判定，总结会被折进组里。
    let lastStepsIndex = -1;
    let lastTextIndex = -1;
    for (let i = flattened.length - 1; i >= 0; i -= 1) {
      const k = flattened[i]!.kind;
      if (lastStepsIndex === -1 && (k === 'tool' || k === 'thinking')) lastStepsIndex = i;
      if (lastTextIndex === -1 && k === 'text') lastTextIndex = i;
      if (lastStepsIndex !== -1 && lastTextIndex !== -1) break;
    }
    const segments: ChatSegment[] = [];
    const isStepLike = (p?: MessagePart) => !!p && (p.kind === 'tool' || p.kind === 'thinking');
    flattened.forEach((part, index) => {
      // 只有过程「文本」进组内段落；error/普通 notice/image 保持独立 text 段（重试隐藏、结论位逻辑都依赖）。
      // 例外：压缩记录（strong notice）是时序事件，紧邻工具/思考步骤时在触发点原位落入过程列表
      // （组内步骤行，用户要求：压缩在哪个时序触发就显示在哪个时序，同 ZCode 过程列表）。
      // 孤立压缩（如手动 /compact 落在末轮结论文本之后、前后都没有步骤）不入组：
      // 否则它会折进一个只显示计时的空组里反而不可见，保持直接可见的 text 段。
      const adjacentToSteps = isStepLike(flattened[index - 1]) || isStepLike(flattened[index + 1]);
      const kind: ChatSegment['kind'] = isStepLike(part) || (part.kind === 'notice' && part.strong && adjacentToSteps) || (part.kind === 'text' && index < lastStepsIndex && index !== lastTextIndex) ? 'steps' : 'text';
      const currentSeg = segments[segments.length - 1];
      if (currentSeg && currentSeg.kind === kind) currentSeg.parts.push(part);
      else segments.push({ kind, parts: [part] });
    });
    turn.segments = segments;
    turn.steps = segments.flatMap((s) => (s.kind === 'steps' ? s.parts : []));
    turn.answer = segments.flatMap((s) => (s.kind === 'text' ? s.parts : []));
    turnCache.set(group.id, { count: group.members.length, first, last, members: group.members, turn });
    turns.push(turn);
  }
  return turns;
}

export function formatElapsed(milliseconds: number, zh: boolean): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60), rest = seconds % 60;
  return [hours ? `${hours}${zh ? '小时' : 'h'}` : '', minutes ? `${minutes}${zh ? '分钟' : 'm'}` : '', `${rest}${zh ? '秒' : 's'}`].filter(Boolean).join(' ');
}
