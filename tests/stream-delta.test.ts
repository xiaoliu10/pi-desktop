import { describe, expect, it } from 'vitest';
import { applyAssistantStreamDelta, type StreamBlock } from '../src/renderer/pi/stream-delta';
import { liveToMessages } from '../src/renderer/pi/adapter';

/** RPC message_update 只带 assistantMessageEvent 增量（partial 被 pi 剥掉）。
 *  不拼装的话流式文本只能等 message_end 落盘——CLI 快 GUI 慢的主因。 */
describe('rpc streaming delta assembly', () => {
  it('accumulates thinking and text deltas into content blocks in order', () => {
    const blocks: StreamBlock[] = [];
    expect(applyAssistantStreamDelta(blocks, { type: 'start' })).toBe(false);
    expect(applyAssistantStreamDelta(blocks, { type: 'thinking_start', contentIndex: 0 })).toBe(false);
    expect(applyAssistantStreamDelta(blocks, { type: 'thinking_delta', contentIndex: 0, delta: '先查' })).toBe(false);
    expect(applyAssistantStreamDelta(blocks, { type: 'thinking_delta', contentIndex: 0, delta: '源码。' })).toBe(false);
    expect(applyAssistantStreamDelta(blocks, { type: 'thinking_end', contentIndex: 0, content: '先查源码。' })).toBe(false);
    expect(applyAssistantStreamDelta(blocks, { type: 'text_start', contentIndex: 1 })).toBe(false);
    expect(applyAssistantStreamDelta(blocks, { type: 'text_delta', contentIndex: 1, delta: '修好' })).toBe(false);
    expect(applyAssistantStreamDelta(blocks, { type: 'text_delta', contentIndex: 1, delta: '了。' })).toBe(false);
    expect(blocks).toEqual([
      { type: 'thinking', thinking: '先查源码。' },
      { type: 'text', text: '修好了。' },
    ]);
  });

  it('out-of-order contentIndex still lands in the right slot; done terminates the stream', () => {
    const blocks: StreamBlock[] = [];
    applyAssistantStreamDelta(blocks, { type: 'text_start', contentIndex: 1 });
    applyAssistantStreamDelta(blocks, { type: 'text_delta', contentIndex: 1, delta: 'b' });
    applyAssistantStreamDelta(blocks, { type: 'text_start', contentIndex: 0 });
    applyAssistantStreamDelta(blocks, { type: 'text_delta', contentIndex: 0, delta: 'a' });
    expect(blocks[0]).toEqual({ type: 'text', text: 'a' });
    expect(blocks[1]).toEqual({ type: 'text', text: 'b' });
    expect(applyAssistantStreamDelta(blocks, { type: 'done', reason: 'stop' })).toBe(true);
  });

  it('toolcall deltas accumulate arguments and toolcall_end replaces authoritatively', () => {
    const blocks: StreamBlock[] = [];
    applyAssistantStreamDelta(blocks, { type: 'toolcall_start', contentIndex: 0 });
    applyAssistantStreamDelta(blocks, { type: 'toolcall_delta', contentIndex: 0, delta: '{"pa' });
    applyAssistantStreamDelta(blocks, { type: 'toolcall_delta', contentIndex: 0, delta: 'th":"a.ts"}' });
    // toolcall_start 的 id/name 在 RPC 里已被剥掉（占位 name: 'tool'），
    // toolcall_end 带权威 toolCall 整体替换。
    applyAssistantStreamDelta(blocks, { type: 'toolcall_end', contentIndex: 0, toolCall: { type: 'toolCall', id: 'tc1', name: 'read', arguments: { path: 'a.ts' } } });
    expect(blocks[0]).toMatchObject({ type: 'toolCall', id: 'tc1', name: 'read', arguments: { path: 'a.ts' } });
  });

  it('assembled blocks render through liveToMessages like saved assistant content', () => {
    const blocks: StreamBlock[] = [
      { type: 'thinking', thinking: '思考中' },
      { type: 'text', text: '回答正文' },
      { type: 'toolCall', id: 'tc9', name: 'bash', arguments: { command: 'ls' } },
    ];
    const msgs = liveToMessages({ 'live-stream': { role: 'assistant', content: blocks } }, undefined);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.parts.map(p => p.kind)).toEqual(['thinking', 'text', 'tool']);
    expect(msgs[0]!.parts[0]).toMatchObject({ kind: 'thinking', text: '思考中' });
    expect(msgs[0]!.parts[2]).toMatchObject({ kind: 'tool', callId: 'tc9', status: 'running' });
  });
});
