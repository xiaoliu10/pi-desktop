import type {
  ChatMessage,
  ChatProvider,
  ChatRequest,
  StreamChunk,
  ToolCallRequest,
} from './base';
import { ProviderError, safeParseJson, sseData } from './base';

/**
 * Anthropic Messages API wire format (streaming).
 */

export const ANTHROPIC_DEFAULT_BASE = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';

interface AnthropicDef {
  baseUrl?: string;
  apiKey: string | null;
}

function systemText(messages: ChatMessage[]): string {
  return messages
    .filter((m) => m.role === 'system')
    .map((m) => (m as { content: string }).content)
    .join('\n\n');
}

function toWireMessages(messages: ChatMessage[]): unknown[] {
  const out: unknown[] = [];
  let pendingToolResults: unknown[] = [];

  const flushToolResults = () => {
    if (pendingToolResults.length) {
      out.push({ role: 'user', content: pendingToolResults });
      pendingToolResults = [];
    }
  };

  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      flushToolResults();
      out.push({ role: 'user', content: [{ type: 'text', text: m.content }] });
    } else if (m.role === 'assistant') {
      flushToolResults();
      const blocks: unknown[] = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const tc of m.toolCalls ?? []) {
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: safeParseJson(tc.arguments) ?? {},
        });
      }
      out.push({ role: 'assistant', content: blocks });
    } else {
      pendingToolResults.push({
        type: 'tool_result',
        tool_use_id: m.result.toolCallId,
        content: m.result.content,
        is_error: !m.result.ok,
      });
    }
  }
  flushToolResults();
  return out;
}

/**
 * Pure accumulator for streamed Anthropic events.
 */
export interface UsageInfo {
  inputTokens?: number;
  outputTokens?: number;
}

export class AnthropicAccumulator {
  text = '';
  private toolBlocks = new Map<number, { id: string; name: string; json: string }>();
  usage: UsageInfo = {};
  finishReason?: string;

  /** Returns text delta if the event carried one. */
  push(event: unknown): string | null {
    const ev = event as {
      type?: string;
      delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
      message?: { usage?: { input_tokens?: number; output_tokens?: number } };
      usage?: { output_tokens?: number };
      content_block?: { type?: string; id?: string; name?: string };
      index?: number;
    };
    switch (ev.type) {
      case 'message_start':
        if (ev.message?.usage) {
          this.usage.inputTokens = ev.message.usage.input_tokens;
        }
        break;
      case 'content_block_start':
        if (ev.content_block?.type === 'tool_use' && ev.content_block.id) {
          this.toolBlocks.set(ev.index ?? 0, {
            id: ev.content_block.id,
            name: ev.content_block.name ?? '',
            json: '',
          });
        }
        break;
      case 'content_block_delta': {
        if (ev.delta?.type === 'text_delta' && ev.delta.text) {
          this.text += ev.delta.text;
          return ev.delta.text;
        }
        if (ev.delta?.type === 'input_json_delta' && ev.delta.partial_json) {
          const blk = this.toolBlocks.get(ev.index ?? 0);
          if (blk) blk.json += ev.delta.partial_json;
        }
        break;
      }
      case 'message_delta':
        if (ev.usage?.output_tokens !== undefined) this.usage.outputTokens = ev.usage.output_tokens;
        if (ev.delta?.stop_reason) this.finishReason = ev.delta.stop_reason;
        break;
      default:
        break;
    }
    return null;
  }

  finish(): { text: string; toolCalls: ToolCallRequest[]; usage: UsageInfo } {
    const toolCalls: ToolCallRequest[] = [...this.toolBlocks.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, b]) => ({ id: b.id, name: b.name, arguments: b.json || '{}' }));
    return { text: this.text, toolCalls, usage: this.usage };
  }
}

export class AnthropicProvider implements ChatProvider {
  constructor(private readonly def: AnthropicDef) {}

  async *stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<StreamChunk> {
    const base = (this.def.baseUrl || ANTHROPIC_DEFAULT_BASE).replace(/\/$/, '');
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.def.apiKey ?? '',
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: req.model,
        max_tokens: req.maxOutputTokens ?? 8192,
        ...(systemText(req.messages) ? { system: systemText(req.messages) } : {}),
        messages: toWireMessages(req.messages),
        ...(req.tools.length
          ? {
              tools: req.tools.map((t) => ({
                name: t.name,
                description: t.description,
                input_schema: t.parameters,
              })),
            }
          : {}),
        stream: true,
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      }),
    });

    const acc = new AnthropicAccumulator();
    for await (const data of sseData(res)) {
      const event = safeParseJson(data);
      if (event === undefined) continue;
      const textDelta = acc.push(event);
      if (textDelta) yield { type: 'text-delta', delta: textDelta };
    }
    const done = acc.finish();
    if (done.usage.inputTokens || done.usage.outputTokens) {
      yield { type: 'usage', usage: done.usage };
    }
    for (const call of done.toolCalls) {
      if (!call.name) throw new ProviderError('Model produced a tool call without a name');
      yield { type: 'tool-call', call };
    }
    yield { type: 'done', finishReason: acc.finishReason };
  }
}
