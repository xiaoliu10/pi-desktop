/**
 * Provider-agnostic chat interface plus normalized message types.
 * Each provider implementation converts to/from its wire format.
 */

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCallRequest {
  id: string;
  name: string;
  /** JSON-encoded arguments object. */
  arguments: string;
}

export interface ToolCallResult {
  toolCallId: string;
  name: string;
  ok: boolean;
  content: string;
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCallRequest[] }
  | { role: 'tool'; result: ToolCallResult };

export interface ToolSchema {
  name: string;
  description: string;
  /** JSON schema for the arguments object. */
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools: ToolSchema[];
  maxOutputTokens?: number;
  temperature?: number;
}

export interface StreamUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export type StreamChunk =
  | { type: 'text-delta'; delta: string }
  | { type: 'tool-call'; call: ToolCallRequest }
  | { type: 'usage'; usage: StreamUsage }
  | { type: 'done'; finishReason?: string };

export interface ChatProvider {
  stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<StreamChunk>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
  }
}

/**
 * Minimal SSE reader over a fetch Response. Yields each `data:` payload
 * (with `[DONE]` passed through for the caller to handle).
 */
export async function* sseData(res: Response): AsyncGenerator<string> {
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ProviderError(`HTTP ${res.status}: ${body.slice(0, 500)}`, res.status);
  }
  if (!res.body) throw new ProviderError('Empty response body');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (line.startsWith('data:')) {
          yield line.slice(5).trim();
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
