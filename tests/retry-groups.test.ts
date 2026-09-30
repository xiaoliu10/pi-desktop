import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RetryGroups, RETRY_GROUP_DELAYS_MS, isTransientUpstreamError } from '../src/main/pi/retry-groups';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
function setup() {
  const resume = vi.fn(async () => {}), changed = vi.fn();
  const groups = new RetryGroups(changed, resume); groups.begin();
  return { groups, resume, changed };
}
function exhaustion(groups: RetryGroups, error = '503 Service unavailable') {
  groups.event({ type: 'message_end', message: { role: 'assistant', stopReason: 'error' } });
  groups.event({ type: 'auto_retry_start', attempt: 3, maxAttempts: 3 });
  groups.event({ type: 'auto_retry_end', success: false, attempt: 3, finalError: error });
}
it('counts initial attempt as group1, waits for settled, and bounds a continuous outage at ten', async () => {
  const { groups, resume } = setup();
  expect(groups.state).toMatchObject({ group: 1, maxGroups: 10 });
  for (let group = 1; group <= 10; group++) {
    exhaustion(groups);
    groups.event({ type: 'agent_end', willRetry: false });
    expect(resume).toHaveBeenCalledTimes(group - 1);
    const intermediate = groups.event({ type: 'agent_settled' });
    expect(intermediate).toBe(group < 10);
    if (group < 10) {
      expect(groups.state).toMatchObject({ group, phase: 'waiting', delayMs: RETRY_GROUP_DELAYS_MS[group - 1] });
      groups.event({ type: 'agent_settled' });
      await vi.advanceTimersByTimeAsync(RETRY_GROUP_DELAYS_MS[group - 1] - 1);
      expect(resume).toHaveBeenCalledTimes(group - 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(resume).toHaveBeenCalledTimes(group);
      groups.event({ type: 'agent_start' });
    }
  }
  expect(groups.state).toMatchObject({ group: 10, phase: 'exhausted' });
  await vi.runAllTimersAsync(); expect(resume).toHaveBeenCalledTimes(9);
});
it('does not replenish the outer budget on internal recovery, tools, deltas, or low-level agent_end', async () => {
  const { groups, resume } = setup(); exhaustion(groups); groups.event({ type: 'agent_settled' });
  await vi.advanceTimersByTimeAsync(10000);
  groups.event({ type: 'agent_start' });
  groups.event({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3 });
  groups.event({ type: 'auto_retry_end', success: true, attempt: 1 });
  groups.event({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'partial' } });
  groups.event({ type: 'message_end', message: { role: 'assistant', stopReason: 'toolUse' } });
  groups.event({ type: 'tool_execution_end', isError: false });
  expect(groups.state?.group).toBe(2);
  exhaustion(groups); groups.event({ type: 'agent_settled' });
  expect(groups.state).toMatchObject({ group: 2, delayMs: 20000 });
  await vi.advanceTimersByTimeAsync(20000); expect(resume).toHaveBeenCalledTimes(2);
  groups.event({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } });
  groups.event({ type: 'agent_settled' });
  expect(groups.state).toMatchObject({ group: 3, phase: 'completed' });
  groups.begin(); expect(groups.state?.group).toBe(1);
});
it.each(['Retry cancelled', '401 invalid API key', 'insufficient_quota 429', 'context window overflow', '', 'unknown failure'])('never retries non-transient final error %s', async error => {
  const { groups, resume } = setup(); exhaustion(groups, error); groups.event({ type: 'agent_settled' });
  await vi.runAllTimersAsync(); expect(resume).not.toHaveBeenCalled();
});
it('requires observed internal exhaustion, not bare failure or a stale prior successful call', async () => {
  const { groups, resume } = setup();
  groups.event({ type: 'auto_retry_end', success: false, attempt: 3, finalError: '503 unavailable' });
  groups.event({ type: 'agent_settled' }); await vi.runAllTimersAsync(); expect(resume).not.toHaveBeenCalled();
  groups.begin(); exhaustion(groups);
  groups.event({ type: 'agent_start' }); // natural queued continuation supersedes failure
  groups.event({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } });
  groups.event({ type: 'agent_settled' }); expect(groups.state?.phase).toBe('completed');
});
it.each(['cancel', 'dispose'] as const)('%s cancels timer immediately, and late events cannot resurrect it', async method => {
  const { groups, resume } = setup(); exhaustion(groups); groups.event({ type: 'agent_settled' });
  groups[method](); exhaustion(groups); groups.event({ type: 'agent_settled' });
  await vi.runAllTimersAsync(); expect(resume).not.toHaveBeenCalled();
});
it('fails closed on ambiguous dispatch, never automatically resends, and fences stale rejection', async () => {
  const { groups, resume } = setup(); resume.mockRejectedValueOnce(new Error('RPC timeout'));
  exhaustion(groups); groups.event({ type: 'agent_settled' }); await vi.runAllTimersAsync();
  expect(groups.state).toMatchObject({ phase: 'failed', error: 'RPC timeout' }); expect(resume).toHaveBeenCalledTimes(1);
  let reject!: (e: Error) => void;
  resume.mockImplementationOnce(() => new Promise((_, r) => { reject = r; }));
  groups.begin(); exhaustion(groups); groups.event({ type: 'agent_settled' }); await vi.advanceTimersByTimeAsync(10000);
  groups.cancel(); groups.begin(); reject(new Error('old error')); await Promise.resolve();
  expect(groups.state).toMatchObject({ group: 1, phase: 'running' });
});
it.each(['toolUse', 'error'])('does not replenish budget for steering after %s', outcome => {
  const { groups } = setup(); groups.state!.group = 9;
  groups.event({ type: 'message_end', message: { role: 'assistant', stopReason: outcome } });
  groups.event({ type: 'message_start', message: { role: 'user', content: 'steering the unfinished task' } });
  expect(groups.state?.group).toBe(9);
});
it('allows known transient upstream/network failures only', () => {
  for (const error of ['529 overloaded', '429 rate limit', 'Connection error.', 'fetch failed', 'ECONNRESET', 'terminated', 'UND_ERR_SOCKET']) expect(isTransientUpstreamError(error)).toBe(true);
  expect(isTransientUpstreamError({ message: '503' })).toBe(false);
});
