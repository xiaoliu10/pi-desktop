import { describe, expect, it } from 'vitest';
import { nextModelRetryState } from '../src/renderer/pi/model-retry';

const start = { type: 'auto_retry_start', attempt: 2, maxAttempts: 3, delayMs: 4000, errorMessage: 'fetch failed' };
const retry = nextModelRetryState(null, start, 1000)!;

describe('pi retry event state', () => {
  it('uses the actual retry count and backoff from pi, not the number of failed requests', () => {
    expect(retry).toEqual({ attempt: 2, max: 3, error: 'fetch failed', retryAt: 5000, phase: 'waiting' });
    expect(nextModelRetryState(retry, { ...start, attempt: 3, delayMs: 8000 }, 2000)).toMatchObject({ attempt: 3, retryAt: 10000 });
  });
  it('does not finish a retry on empty stream starts, error deltas or agent_end', () => {
    const requesting = nextModelRetryState(retry, { type: 'message_start', message: { role: 'assistant', content: [] } }, 5000)!;
    expect(requesting).toMatchObject({ attempt: 2, phase: 'requesting' });
    for (const event of [
      { type: 'message_update', assistantMessageEvent: { type: 'start' } },
      { type: 'message_update', assistantMessageEvent: { type: 'error' } },
      { type: 'message_end', message: { role: 'assistant', stopReason: 'error' } },
      { type: 'agent_end', willRetry: false },
    ]) expect(nextModelRetryState(requesting, event, 6000)).toBe(requesting);
  });
  it('retains the count while output resumes, without calling the task successful', () => {
    expect(nextModelRetryState(retry, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hello' } }, 5000)).toMatchObject({ phase: 'streaming', attempt: 2 });
    expect(nextModelRetryState(retry, { type: 'message_update', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'checking' }] } }, 5000)).toMatchObject({ phase: 'streaming' });
  });
  it.each([
    { type: 'auto_retry_end', success: true },
    { type: 'auto_retry_end', success: false, finalError: 'fetch failed' },
    { type: 'auto_retry_end', success: false, finalError: 'Retry cancelled' },
    { type: 'message_end', message: { role: 'assistant', stopReason: 'aborted' } },
    { type: 'agent_settled' },
  ])('clears terminal state without manufacturing another error: %o', event => {
    expect(nextModelRetryState(retry, event, 6000)).toBeNull();
  });
  it('redacts retry errors and bounds malformed counters', () => {
    const state = nextModelRetryState(null, { ...start, attempt: NaN, maxAttempts: Infinity, delayMs: -1, errorMessage: 'Authorization: Bearer SECRET_TOKEN' }, 1000)!;
    expect(state).toMatchObject({ attempt: 1, max: 0, retryAt: 1000, phase: 'requesting' });
    expect(state.error).not.toContain('SECRET_TOKEN');
  });
});
