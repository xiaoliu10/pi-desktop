import { describe, expect, it } from 'vitest';
import { OutputPerformanceTracker } from '../src/main/pi/output-performance';

const generation = 'g1';
const message = (timestamp: number, overrides: Record<string, unknown> = {}) => ({
  role: 'assistant', timestamp, api: 'test-api', provider: 'test-provider', model: 'test-model',
  content: [], stopReason: 'pending', ...overrides,
});
const start = (timestamp: number) => ({ type: 'message_start', message: message(timestamp) });
const end = (timestamp: number, output: unknown = 100, content: unknown[] = [{ type: 'text', text: 'answer' }], stopReason = 'stop') => ({
  type: 'message_end', message: message(timestamp, { content, stopReason, usage: { output } }),
});
// Real wire updates have no message/partial identity and no reliable live usage.
const update = (type: string, fields: Record<string, unknown> = {}) => ({ type: 'message_update', usage: { output: 0 }, assistantMessageEvent: { type, contentIndex: 0, ...fields } });
function setup() {
  let clock = 0;
  const tracker = new OutputPerformanceTracker(generation, () => clock);
  const feed = (event: Record<string, any>, ms = 0, gen = generation) => { clock += ms; return tracker.observe(event, gen); };
  const text = (timestamp: number, kind = 'text', value = 'answer') => {
    feed(start(timestamp)); feed(update(`${kind}_start`)); feed(update(`${kind}_delta`, { delta: value }), 500);
  };
  return { tracker, feed, text };
}

describe('connection-local output performance', () => {
  it('weights unequal call durations and excludes first-token/tool/approval waits', () => {
    const { feed, text, tracker } = setup();
    text(1);
    expect(feed(end(1, 100), 100)).toEqual({ tokens: 100, ms: 100, calls: 1 });
    feed({ type: 'tool_execution_start' }, 20_000);
    feed({ type: 'extension_ui_request', method: 'confirm' }, 80_000);
    feed({ type: 'tool_execution_end' }, 20_000);
    text(2);
    expect(feed(end(2, 150), 300)).toEqual({ tokens: 250, ms: 400, calls: 2 });
    const result = tracker.snapshot()!;
    expect(result.tokens / result.ms * 1000).toBe(625); // NOT mean(1000, 500)
    feed(end(2, 150), 10_000);
    expect(tracker.snapshot()).toEqual(result); // duplicate end
  });

  it('measures thinking deltas too; handles Unicode split across chunks', () => {
    const { feed } = setup();
    feed(start(1)); feed(update('thinking_start'));
    feed(update('thinking_delta', { delta: '\ud83d' }), 1000);
    feed(update('thinking_delta', { delta: '\ude00' }), 50);
    expect(feed(end(1, 200, [{ type: 'thinking', thinking: '😀' }]), 50)).toEqual({ tokens: 200, ms: 100, calls: 1 });
  });

  it('pairs tool-only streams using actual toolcall_start id/toolName and end arguments', () => {
    const { feed } = setup();
    feed(start(1)); feed(update('toolcall_start', { id: 'tc1', toolName: 'read' }));
    feed(update('toolcall_delta', { delta: '{"path":' }), 3000);
    feed(update('toolcall_delta', { delta: '"a.ts"}' }), 50);
    const toolCall = { type: 'toolCall', id: 'tc1', name: 'read', arguments: { path: 'a.ts' } };
    feed(update('toolcall_end', { toolCall }), 50);
    expect(feed(end(1, 80, [toolCall], 'toolUse'))).toEqual({ tokens: 80, ms: 100, calls: 1 });
  });

  it.each(['error', 'aborted', 'pending', 'deferred'])('excludes non-completed %s calls', stop => {
    const { feed, text, tracker } = setup(); text(1);
    expect(feed(end(1, 999, undefined, stop), 100)).toBeUndefined();
    expect(tracker.snapshot()).toBeUndefined();
    expect(feed(end(1), 100)).toBeUndefined();
  });

  it.each([undefined, null, -1, NaN, Infinity, '100'])('excludes missing/invalid final usage.output: %s', output => {
    const { feed, text, tracker } = setup(); text(1);
    const completed = end(1);
    completed.message.usage.output = output;
    expect(feed(completed, 100)).toBeUndefined();
    expect(tracker.snapshot()).toBeUndefined();
  });

  it('excludes missing usage, zero/negative/nonfinite duration; accepts valid zero output', () => {
    const s = setup(); s.text(1);
    expect(s.feed({ type: 'message_end', message: message(1, { stopReason: 'stop' }) }, 100)).toBeUndefined();
    s.text(2); expect(s.feed(end(2), 0)).toBeUndefined();
    s.text(3); expect(s.feed(end(3), -10)).toBeUndefined();
    s.text(4); expect(s.feed(end(4, 0), 10)).toEqual({ tokens: 0, ms: 10, calls: 1 });
    const t = setup(); t.text(1); expect(t.feed(end(1), Infinity)).toBeUndefined();
  });

  it('does not start timing on empty deltas or block starts', () => {
    const { feed } = setup(); feed(start(1)); feed(update('text_start'), 500);
    feed(update('text_delta', { delta: '' }), 500);
    feed(update('text_delta', { delta: 'answer' }), 500);
    expect(feed(end(1), 10)?.ms).toBe(10);
    feed(start(2)); feed(update('toolcall_start', { id: 'empty', toolName: 'noop' }));
    const toolCall = { type: 'toolCall', id: 'empty', name: 'noop', arguments: {} };
    feed(update('toolcall_end', { toolCall }));
    expect(feed(end(2, 10, [toolCall], 'toolUse'), 10)).toBeUndefined(); // no nonempty delta
  });

  it('ignores stale starts and ends without clearing or re-pairing the current sample', () => {
    const { feed, text, tracker } = setup(); text(1); feed(end(1), 100);
    text(2);
    feed(start(1)); feed(end(1, 999_999), 10);
    expect(feed(end(2, 50), 90)).toEqual({ tokens: 150, ms: 200, calls: 2 });
    expect(tracker.snapshot()?.tokens).toBe(150);
  });

  it('rejects late identity-less deltas when final content differs', () => {
    const { feed, text, tracker } = setup(); text(2);
    feed(update('text_delta', { delta: 'old response' }), 10);
    expect(feed(end(2), 100)).toBeUndefined();
    expect(tracker.snapshot()).toBeUndefined();
  });

  it('fails closed on overlapping starts until a settlement boundary', () => {
    const { feed, text } = setup(); text(1); text(2);
    expect(feed(end(1), 100)).toBeUndefined(); expect(feed(end(2), 100)).toBeUndefined();
    feed({ type: 'agent_settled' }); text(3);
    expect(feed(end(3), 100)?.calls).toBe(1);
  });

  it('rejects missing identity; never invents a message ID', () => {
    const { feed, tracker } = setup();
    feed({ type: 'message_start', message: { role: 'assistant' } });
    feed(update('text_start')); feed(update('text_delta', { delta: 'answer' }));
    expect(feed(end(1), 100)).toBeUndefined(); expect(tracker.snapshot()).toBeUndefined();
  });

  it.each(['agent_end', 'agent_settled', 'abort'])('%s clears pending but preserves valid totals', type => {
    const { feed, text, tracker } = setup(); text(1); feed(end(1), 100);
    text(2); feed({ type }); expect(feed(end(2), 10_000)).toBeUndefined();
    text(3); expect(feed(end(3, 50), 100)).toEqual({ tokens: 150, ms: 200, calls: 2 });
    expect(tracker.snapshot()?.calls).toBe(2);
  });

  it('isolates host connection generations and foreign event generations', () => {
    const { feed, text, tracker } = setup(); text(1);
    feed(end(1, 999), 100, 'old-generation');
    feed({ ...end(1, 999), generation: 'old-generation' }, 100);
    expect(tracker.snapshot()).toBeUndefined();
    expect(feed(end(1, 50), 100)).toEqual({ tokens: 50, ms: 300, calls: 1 });
    expect(new OutputPerformanceTracker('g2').snapshot()).toBeUndefined();
  });

  it.each(['missing-id', 'bad-end', 'bad-json', 'mismatched-final', 'oversized'])('fails closed for unsafe tool-only stream: %s', defect => {
    const { feed, tracker } = setup(); feed(start(1));
    feed(update('toolcall_start', { id: defect === 'missing-id' ? undefined : 'tc', toolName: 'read' }));
    feed(update('toolcall_delta', { delta: defect === 'bad-json' ? '{' : defect === 'oversized' ? 'x'.repeat(256 * 1024 + 1) : '{"path":"a.ts"}' }), 500);
    const toolCall = { type: 'toolCall', id: 'tc', name: 'read', arguments: { path: 'a.ts' } };
    feed(update('toolcall_end', { toolCall: defect === 'bad-end' ? { ...toolCall, id: 'other' } : toolCall }));
    const final = defect === 'mismatched-final' ? { ...toolCall, arguments: { path: 'b.ts' } } : toolCall;
    expect(feed(end(1, 99, [final], 'toolUse'), 100)).toBeUndefined();
    expect(tracker.snapshot()).toBeUndefined();
  });
});
