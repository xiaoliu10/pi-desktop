import type { ChatMessage, MessagePart, ToolPart } from '../contracts';
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
const turnCache = new Map<string, { count: number; first: ChatMessage; last: ChatMessage; turn: ChatTurn }>();

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
    if (hit && hit.count === group.members.length && hit.first === first && hit.last === last) { turns.push(hit.turn); continue; }
    const turn: ChatTurn = { startedAt: group.startedAt, id: group.id, role: 'assistant', messageIds: [], segments: [], steps: [], answer: [], simulated: first.simulated, model: first.model };
    for (const message of group.members) {
      if (message.timestamp !== undefined) turn.endedAt = Math.max(turn.endedAt ?? message.timestamp, message.timestamp);
      turn.messageIds.push(message.id);
      turn.steps.push(...message.parts);
    }
    const flattened: MessagePart[] = [];
    const tools = new Map<string, ToolPart>();
    for (const part of turn.steps) {
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
    // Chronological segments: a text (or error) conclusion closes the current
    // steps disclosure; later tools open a NEW one after it. All text stays
    // visible outside the disclosures, so the final result is never buried.
    const segments: ChatSegment[] = [];
    for (const part of flattened) {
      const kind: ChatSegment['kind'] = part.kind === 'tool' || part.kind === 'thinking' ? 'steps' : 'text';
      const currentSeg = segments[segments.length - 1];
      if (currentSeg && currentSeg.kind === kind) currentSeg.parts.push(part);
      else segments.push({ kind, parts: [part] });
    }
    turn.segments = segments;
    turn.steps = segments.flatMap((s) => (s.kind === 'steps' ? s.parts : []));
    turn.answer = segments.flatMap((s) => (s.kind === 'text' ? s.parts : []));
    turnCache.set(group.id, { count: group.members.length, first, last, turn });
    turns.push(turn);
  }
  return turns;
}

export function formatElapsed(milliseconds: number, zh: boolean): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60), rest = seconds % 60;
  return [hours ? `${hours}${zh ? '小时' : 'h'}` : '', minutes ? `${minutes}${zh ? '分钟' : 'm'}` : '', `${rest}${zh ? '秒' : 's'}`].filter(Boolean).join(' ');
}
