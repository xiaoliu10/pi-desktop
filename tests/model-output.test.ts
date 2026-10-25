import { describe, expect, it } from 'vitest';
import { hasModelOutput } from '../src/shared/model-output';

describe('model output recovery evidence', () => {
  it.each(['text_delta', 'thinking_delta', 'toolcall_delta'])('accepts a nonempty %s', type => {
    expect(hasModelOutput({ type: 'message_update', assistantMessageEvent: { type, delta: 'output' } })).toBe(true);
    expect(hasModelOutput({ type: 'message_update', assistantMessageEvent: { type, delta: '' } })).toBe(false);
  });
  it.each(['plain output', [{ type: 'text', text: 'answer' }], [{ type: 'thinking', thinking: 'reasoning' }], [{ type: 'toolCall', id: 'call' }]])('accepts assistant snapshots: %j', content => {
    expect(hasModelOutput({ type: 'message_update', message: { role: 'assistant', content } })).toBe(true);
  });
  it.each([
    { type: 'message_start', message: { role: 'assistant', content: 'not an update' } },
    { type: 'message_update', message: { role: 'toolResult', content: 'tool output' } },
    { type: 'message_update', message: { role: 'user', content: 'user input' } },
    { type: 'message_update', assistantMessageEvent: { type: 'start' } },
    { type: 'message_update', assistantMessageEvent: { type: 'error' }, message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'stale partial' }] } },
    { type: 'message_update', message: { role: 'assistant', content: [null, { type: 'text', text: '' }, { type: 'thinking', thinking: '' }] } },
  ])('rejects non-evidence: %j', event => {
    expect(hasModelOutput(event)).toBe(false);
  });
});
