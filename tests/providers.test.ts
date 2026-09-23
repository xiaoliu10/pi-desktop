import { describe, expect, it } from 'vitest';
import { AnthropicAccumulator } from '../src/main/providers/anthropic';
import { OpenAIAccumulator } from '../src/main/providers/openai';
import { sseData } from '../src/main/providers/base';

describe('OpenAIAccumulator', () => {
  it('accumulates streamed text and multi-chunk tool calls', () => {
    const acc = new OpenAIAccumulator();
    const deltas: string[] = [];
    const chunks = [
      { choices: [{ delta: { content: 'Hello' } }] },
      { choices: [{ delta: { content: ' world' } }] },
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: 'call_1', function: { name: 'edit_', arguments: '' } }],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { name: 'file', arguments: '{"path":"a.ts' } }],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: { tool_calls: [{ index: 0, function: { arguments: '","content":"x"}' } }] },
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ];
    for (const c of chunks) {
      const d = acc.push(c);
      if (d) deltas.push(d);
    }
    expect(deltas.join('')).toBe('Hello world');
    const done = acc.finish();
    expect(done.text).toBe('Hello world');
    expect(done.toolCalls).toEqual([
      { id: 'call_1', name: 'edit_file', arguments: '{"path":"a.ts","content":"x"}' },
    ]);
    expect(done.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });
});

describe('AnthropicAccumulator', () => {
  it('accumulates text and input_json_delta tool blocks', () => {
    const acc = new AnthropicAccumulator();
    const deltas: string[] = [];
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 42, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Plan: ' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'do it' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"pa' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'th":"a.ts"}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 17 } },
    ];
    for (const ev of events) {
      const d = acc.push(ev);
      if (d) deltas.push(d);
    }
    expect(deltas.join('')).toBe('Plan: do it');
    const done = acc.finish();
    expect(done.text).toBe('Plan: do it');
    expect(done.toolCalls).toEqual([{ id: 'toolu_1', name: 'read_file', arguments: '{"path":"a.ts"}' }]);
    expect(done.usage).toEqual({ inputTokens: 42, outputTokens: 17 });
  });
});

describe('sseData', () => {
  it('yields data payloads across chunk boundaries', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"a":1}\ndata:{\"b\":2}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n'));
        controller.close();
      },
    });
    const out: string[] = [];
    for await (const data of sseData(new Response(stream))) {
      out.push(data);
    }
    expect(out).toEqual(['{"a":1}', '{"b":2}', '[DONE]']);
  });

  it('throws ProviderError with status on http error', async () => {
    await expect(async () => {
      for await (const _ of sseData(new Response('nope', { status: 401 }))) {
        void _;
      }
    }).rejects.toThrow(/401/);
  });
});
