import type {
  ChatMessage,
  ChatProvider,
  ChatRequest,
  StreamChunk,
  ToolCallRequest,
  ToolSchema,
} from './base';
import { ProviderError, safeParseJson, sseData } from './base';
import type { UsageInfo } from './anthropic';

/**
 * OpenAI Chat Completions wire format (works with OpenAI, DeepSeek, Ollama,
 * LM Studio, vLLM and any other OpenAI-compatible endpoint).
 */

interface OpenAIDef {
  baseUrl?: string;
  apiKey: string | null;
}

export const OPENAI_DEFAULT_BASE = 'https://api.openai.com/v1';

function toWireMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === 'system') return { role: 'system', content: m.content };
    if (m.role === 'user') return { role: 'user', content: m.content };
    if (m.role === 'assistant') {
      const out: Record<string, unknown> = { role: 'assistant', content: m.content || null };
      if (m.toolCalls?.length) {
        out.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        }));
      }
      return out;
    }
    return {
      role: 'tool',
      tool_call_id: m.result.toolCallId,
      content: m.result.content,
    };
  });
}

function toWireTools(tools: ToolSchema[]): unknown[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/**
 * Pure accumulator for streamed chat-completion chunks. Kept separate from
 * network code so tests can feed recorded chunk sequences.
 */
export class OpenAIAccumulator {
  text = '';
  private calls = new Map<number, ToolCallRequest>();
  usage: UsageInfo = {};
  finishReason?: string;

  /** Returns text delta if the chunk carried one. */
  push(chunk: unknown): string | null {
    const c = chunk as {
      choices?: Array<{
        delta?: { content?: string | null; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> };
        finish_reason?: string | null;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
    };
    if (c.usage) {
      this.usage = { inputTokens: c.usage.prompt_tokens, outputTokens: c.usage.completion_tokens };
    }
    const choice = c.choices?.[0];
    if (!choice) return null;
    if (choice.finish_reason) this.finishReason = choice.finish_reason;
    const delta = choice.delta;
    let textDelta: string | null = null;
    if (typeof delta?.content === 'string' && delta.content.length > 0) {
      this.text += delta.content;
      textDelta = delta.content;
    }
    for (const tc of delta?.tool_calls ?? []) {
      const idx = tc.index ?? 0;
      const cur = this.calls.get(idx) ?? { id: '', name: '', arguments: '' };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name += tc.function.name;
      if (tc.function?.arguments) cur.arguments += tc.function.arguments;
      this.calls.set(idx, cur);
    }
    return textDelta;
  }

  finish(): { text: string; toolCalls: ToolCallRequest[]; usage: UsageInfo } {
    return {
      text: this.text,
      toolCalls: [...this.calls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v),
      usage: this.usage,
    };
  }
}

export class OpenAICompatibleProvider implements ChatProvider {
  constructor(private readonly def: OpenAIDef) {}

  async *stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<StreamChunk> {
    const base = (this.def.baseUrl || OPENAI_DEFAULT_BASE).replace(/\/$/, '');
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        ...(this.def.apiKey ? { Authorization: `Bearer ${this.def.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: req.model,
        messages: toWireMessages(req.messages),
        ...(req.tools.length ? { tools: toWireTools(req.tools) } : {}),
        stream: true,
        stream_options: { include_usage: true },
        ...(req.maxOutputTokens ? { max_tokens: req.maxOutputTokens } : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      }),
    });

    const acc = new OpenAIAccumulator();
    for await (const data of sseData(res)) {
      if (data === '[DONE]') break;
      const chunk = safeParseJson(data);
      if (chunk === undefined) continue;
      const textDelta = acc.push(chunk);
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
