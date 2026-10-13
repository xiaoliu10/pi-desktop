import { createHash, type Hash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { PiOutputPerformance } from '../../shared/pi';

type RecordValue = Record<string, any>;
interface Block {
  kind: 'text' | 'thinking' | 'toolCall';
  hash: Hash;
  id?: string;
  name?: string;
  toolCall?: RecordValue;
  argumentsJson?: string;
}
interface Pending {
  identity: string;
  firstDeltaAt?: number;
  blocks: Map<number, Block>;
}
const valid = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const digest = (text: string) => createHash('sha256').update(text, 'utf16le').digest('hex');
// Avoid an unbounded second copy of tool arguments; oversized samples fail closed.
const MAX_ARGUMENT_CHARS = 256 * 1024;

/** Local pi toJsonEvent strips message/partial from updates; it does NOT supply a
 * response ID. Start/end retain timestamp + api/provider/model; toolcall_start
 * retains id/toolName. Never invent an ID or streaming token counter.
 *
 * Only sequential, fully matched streams qualify. Hash text/thinking deltas to
 * compare with final content without retaining another transcript. Tool streams
 * require matching start/end/final tool-call IDs and arguments. Ambiguous overlap
 * or missing identity fails closed. Timings start at the first nonempty delta,
 * not at message_start; no timer, no per-delta IPC, no historical reconstruction.
 */
export class OutputPerformanceTracker {
  private pending?: Pending;
  private ambiguous = false;
  private latestTimestamp = -1;
  private totals?: PiOutputPerformance;

  constructor(private readonly generation: string, private readonly now = () => performance.now()) {}

  private identity(message: RecordValue | undefined): string | undefined {
    if (!message || message.role !== 'assistant' || !valid(message.timestamp)) return;
    if (![message.api, message.provider, message.model].every(v => typeof v === 'string' && v.length > 0)) return;
    return JSON.stringify([message.timestamp, message.api, message.provider, message.model]);
  }

  /** Returns a new aggregate only on a valid completion. Generation is the host's
   * connection identity, NOT a made-up field on pi's wire events. */
  observe(event: RecordValue, generation: string): PiOutputPerformance | undefined {
    if (generation !== this.generation || (event.generation !== undefined && event.generation !== generation)) return;
    if (['agent_settled', 'agent_end', 'abort'].includes(event.type)) { this.clear(); return; }
    if (event.type === 'message_start' && event.message?.role === 'assistant') {
      const identity = this.identity(event.message);
      if (!identity) { this.pending = undefined; this.ambiguous = true; return; }
      if (event.message.timestamp <= this.latestTimestamp) return;
      this.latestTimestamp = event.message.timestamp;
      // Updates have no identity: an overlapping start makes both streams unsafe
      // until a real agent boundary (agent_settled/agent_end/abort). Never pair
      // old deltas with the newer call. ambiguous is sticky by design.
      if (this.pending || this.ambiguous) { this.pending = undefined; this.ambiguous = true; return; }
      this.pending = { identity, blocks: new Map() };
      return;
    }
    const pending = this.pending;
    if (!pending || this.ambiguous) return;
    if (event.type === 'message_update') {
      const delta = event.assistantMessageEvent;
      if (!delta || typeof delta.type !== 'string' || !Number.isInteger(delta.contentIndex) || delta.contentIndex < 0) return;
      const index = delta.contentIndex;
      const kind = delta.type?.startsWith('text_') ? 'text' : delta.type?.startsWith('thinking_') ? 'thinking' : delta.type?.startsWith('toolcall_') ? 'toolCall' : undefined;
      if (!kind || !['text_start', 'text_delta', 'text_end', 'thinking_start', 'thinking_delta', 'thinking_end', 'toolcall_start', 'toolcall_delta', 'toolcall_end'].includes(delta.type)) return;
      if (delta.type.endsWith('_start')) {
        if (pending.blocks.has(index)) { this.pending = undefined; return; }
        if (kind === 'toolCall' && (typeof delta.id !== 'string' || !delta.id || typeof delta.toolName !== 'string' || !delta.toolName)) { this.pending = undefined; return; }
        pending.blocks.set(index, { kind, hash: createHash('sha256'), id: delta.id, name: delta.toolName, argumentsJson: kind === 'toolCall' ? '' : undefined });
        return;
      }
      const block = pending.blocks.get(index);
      if (!block || block.kind !== kind) { this.pending = undefined; return; }
      if (delta.type.endsWith('_delta') && typeof delta.delta === 'string' && delta.delta.length > 0) {
        if (kind === 'toolCall') {
          block.argumentsJson += delta.delta;
          if (block.argumentsJson!.length > MAX_ARGUMENT_CHARS) { this.pending = undefined; return; }
        } else {
          // UTF-16 preserves code units even when a surrogate pair is split across deltas.
          block.hash.update(delta.delta, 'utf16le');
        }
        pending.firstDeltaAt ??= this.now();
      }
      if (delta.type === 'toolcall_end') {
        if (delta.toolCall?.id !== block.id || delta.toolCall?.name !== block.name) { this.pending = undefined; return; }
        block.toolCall = delta.toolCall;
      }
      return;
    }
    if (event.type !== 'message_end' || event.message?.role !== 'assistant') return;
    const message = event.message;
    // A stale end must NOT clear the current sample or pair its usage with it.
    if (this.identity(message) !== pending.identity) return;
    this.pending = undefined;
    if (!['stop', 'length', 'toolUse'].includes(message.stopReason) || pending.firstDeltaAt === undefined) return;
    const output = message.usage?.output;
    const ms = this.now() - pending.firstDeltaAt;
    if (!valid(output) || !Number.isFinite(ms) || ms <= 0 || !Array.isArray(message.content) || message.content.length !== pending.blocks.size) return;
    for (let index = 0; index < message.content.length; index++) {
      const content = message.content[index], block = pending.blocks.get(index);
      if (!block || content?.type !== block.kind) return;
      if (block.kind === 'toolCall') {
        if (!block.toolCall || content.id !== block.id || content.name !== block.name || !isDeepStrictEqual(content.arguments, block.toolCall.arguments)) return;
        // Streamed arguments must also reassemble to the final object; empty-args calls
        // legitimately stream no deltas and are covered by the toolcall_end match above.
        if (block.argumentsJson && block.argumentsJson.length > 0) {
          try { if (!isDeepStrictEqual(JSON.parse(block.argumentsJson), content.arguments)) return; } catch { return; }
        }
      } else {
        const text = content[block.kind];
        if (typeof text !== 'string' || digest(text) !== block.hash.copy().digest('hex')) return;
      }
    }
    const tokens = (this.totals?.tokens ?? 0) + output;
    const duration = (this.totals?.ms ?? 0) + ms;
    if (!valid(tokens) || !Number.isFinite(duration)) return;
    this.totals = { tokens, ms: duration, calls: (this.totals?.calls ?? 0) + 1 };
    return { ...this.totals };
  }

  /** Clear pending at settlement/abort, keeping valid totals for this connection. */
  clear(): void { this.pending = undefined; this.ambiguous = false; }
  snapshot(): PiOutputPerformance | undefined { return this.totals ? { ...this.totals } : undefined; }
}
