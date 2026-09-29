import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePiStore } from '../src/renderer/pi/adapter';
import type { PiEvent, PiRun } from '../src/shared/pi';

let emit: (event: PiEvent) => void;
const focusListeners: Array<() => void> = [];
const run: PiRun = { key: 'retry-a', generation: 'g1', cwd: '/mock', file: '/mock/a.jsonl', status: 'running', models: [], commands: [], pending: 0 };
const other = { ...run, key: 'retry-b', generation: 'g2' };
const api = {
  onEvent: (listener: typeof emit) => { emit = listener; },
  settingsSnapshot: vi.fn().mockRejectedValue('no settings'), environment: vi.fn().mockRejectedValue('mock'),
  sessions: vi.fn().mockResolvedValue([]), runs: vi.fn().mockResolvedValue([]), archivedSessions: vi.fn().mockResolvedValue([]),
  history: vi.fn().mockResolvedValue({ branch: [], entries: [], leaves: [] }), recoverSubagents: vi.fn().mockResolvedValue([]),
  stop: vi.fn().mockResolvedValue({ steering: [], followUp: [] }),
};
const rpc = (event: Record<string, unknown>, target = run) => emit({ type: 'rpc', key: target.key, generation: target.generation, event });
const start = { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: 'fetch failed' };

beforeAll(async () => {
  vi.useFakeTimers();
  vi.stubGlobal('window', { localPi: api, addEventListener: (type: string, listener: () => void) => { if (type === 'focus') focusListeners.push(listener); } });
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: () => undefined });
  usePiStore.getState().init();
  await vi.advanceTimersByTimeAsync(0);
});
beforeEach(async () => {
  await vi.advanceTimersByTimeAsync(500);
  api.stop.mockClear();
  usePiStore.setState({ selectedKey: run.key, runs: [run, other], retrying: {}, notifications: [], live: {}, toolProgress: {}, history: { branch: [] } as never, sends: [], pendingSteer: {}, sentAt: undefined, error: undefined });
});
afterAll(async () => { await vi.advanceTimersByTimeAsync(500); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('retry UI event integration', () => {
  it('updates one retry state per session without adding a notification for each attempt', () => {
    rpc(start); rpc({ ...start, attempt: 2, delayMs: 4000 }); rpc(start, other);
    expect(usePiStore.getState().retrying[run.key]).toMatchObject({ attempt: 2, max: 3, error: 'fetch failed', phase: 'waiting' });
    expect(usePiStore.getState().retrying[other.key]?.attempt).toBe(1);
    expect(usePiStore.getState().notifications).toEqual([]);
    rpc({ type: 'auto_retry_end', success: false, finalError: 'fetch failed' });
    expect(usePiStore.getState().retrying[run.key]).toBeNull();
    expect(usePiStore.getState().retrying[other.key]).not.toBeNull();
    expect(usePiStore.getState().notifications).toEqual([]);
  });
  it('keeps retry progress through an empty/error stream and clears on successful completion', async () => {
    rpc(start);
    rpc({ type: 'message_start', message: { role: 'assistant', timestamp: 1, content: [] } });
    rpc({ type: 'message_update', assistantMessageEvent: { type: 'start' } });
    expect(usePiStore.getState().retrying[run.key]?.attempt).toBe(1);
    rpc({ type: 'message_end', message: { role: 'assistant', timestamp: 1, content: [], stopReason: 'error', errorMessage: 'fetch failed' } });
    expect(usePiStore.getState().retrying[run.key]).not.toBeNull();
    rpc({ ...start, attempt: 2 });
    rpc({ type: 'message_start', message: { role: 'assistant', timestamp: 2, content: [] } });
    rpc({ type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 0 } });
    rpc({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Recovered' } });
    expect(usePiStore.getState().retrying[run.key]).toMatchObject({ attempt: 2, phase: 'streaming' });
    rpc({ type: 'auto_retry_end', success: true });
    expect(usePiStore.getState().retrying[run.key]).toBeNull();
    await vi.advanceTimersByTimeAsync(500);
  });
  it('the stop action cancels only the selected run and clears its retry immediately', async () => {
    rpc(start); rpc(start, other);
    usePiStore.getState().stop();
    expect(api.stop).toHaveBeenCalledTimes(1);
    expect(api.stop).toHaveBeenCalledWith(run.key);
    expect(usePiStore.getState().retrying[run.key]).toBeNull();
    expect(usePiStore.getState().retrying[other.key]).not.toBeNull();
    expect(usePiStore.getState().runs.find(item => item.key === run.key)?.status).toBe('stopping');
    await vi.advanceTimersByTimeAsync(0);
  });
  it.each(['idle', 'stopping', 'error'] as const)('clears a retry when the run becomes %s', status => {
    rpc(start); emit({ type: 'run', run: { ...run, status } });
    expect(usePiStore.getState().retrying[run.key]).toBeNull();
  });
  it('clears on settlement, generation replacement and close, ignoring an old generation close', async () => {
    rpc(start); rpc({ type: 'agent_settled' });
    expect(usePiStore.getState().retrying[run.key]).toBeNull();
    rpc(start); emit({ type: 'run', run: { ...run, generation: 'new' } });
    expect(usePiStore.getState().retrying[run.key]).toBeNull();
    rpc(start, { ...run, generation: 'new' });
    emit({ type: 'closed', key: run.key, generation: run.generation });
    expect(usePiStore.getState().retrying[run.key]).not.toBeNull();
    emit({ type: 'closed', key: run.key, generation: 'new' });
    expect(usePiStore.getState().retrying[run.key]).toBeNull();
    await vi.advanceTimersByTimeAsync(500);
  });
  it('refreshes intermediate settlement without idling the run or touching host state', async () => {
    const retryGroup = Object.freeze({ group: 1, maxGroups: 10, phase: 'waiting' as const, nextRetryAt: Date.now() + 10000 });
    emit({ type: 'run', run: { ...run, retryGroup } });
    rpc(start); // Delayed CLI state must be cleared by the Desktop boundary too.
    api.history.mockClear();
    rpc({ type: 'desktop_retry_group_wait', retryGroup });
    expect(usePiStore.getState().retrying[run.key]).toBeNull();
    expect(usePiStore.getState().runs.find(item => item.key === run.key)).toMatchObject({ status: 'running', retryGroup });
    await vi.advanceTimersByTimeAsync(500);
    expect(api.history).toHaveBeenCalled();
    expect(usePiStore.getState().runs.find(item => item.key === run.key)?.retryGroup).toBe(retryGroup);
    expect(usePiStore.getState().runs.find(item => item.key === run.key)?.status).toBe('running');
    expect(usePiStore.getState().notifications).toEqual([]);
  });
  it.each(['waiting', 'running'] as const)('cancels outer %s via existing stop without modifying the host budget', async phase => {
    const retryGroup = Object.freeze({ group: 4, maxGroups: 10, phase });
    emit({ type: 'run', run: { ...run, retryGroup } });
    usePiStore.getState().stop();
    expect(api.stop).toHaveBeenCalledWith(run.key);
    expect(usePiStore.getState().runs.find(item => item.key === run.key)).toMatchObject({ status: 'stopping', retryGroup });
    expect(usePiStore.getState().runs.find(item => item.key === run.key)?.retryGroup).toBe(retryGroup);
    await vi.advanceTimersByTimeAsync(0);
    emit({ type: 'run', run: { ...run, status: 'idle', retryGroup: { ...retryGroup, phase: 'cancelled' } } });
    expect(usePiStore.getState().runs.find(item => item.key === run.key)?.retryGroup).toMatchObject({ group: 4, phase: 'cancelled' });
  });
  it.each(['waiting', 'completed', 'exhausted', 'failed', 'cancelled'] as const)('host %s retires inner state even before the idle event', phase => {
    rpc(start);
    const retryGroup = { group: 10, maxGroups: 10, phase };
    emit({ type: 'run', run: { ...run, retryGroup } });
    expect(usePiStore.getState().retrying[run.key]).toBeNull();
    expect(usePiStore.getState().runs.find(item => item.key === run.key)?.retryGroup).toEqual(retryGroup);
  });
  it('CLI completion and starts never reset the Desktop group budget', () => {
    const retryGroup = Object.freeze({ group: 7, maxGroups: 10, phase: 'running' as const });
    emit({ type: 'run', run: { ...run, retryGroup } });
    rpc(start); rpc({ type: 'auto_retry_end', success: true }); rpc({ type: 'agent_start' }); rpc(start);
    expect(usePiStore.getState().runs.find(item => item.key === run.key)?.retryGroup).toBe(retryGroup);
  });
  it('a stale focus snapshot from an old generation cannot clear the newer generation retry', async () => {
    rpc(start);
    let resolveRuns!: (value: PiRun[]) => void;
    api.runs.mockImplementationOnce(() => new Promise<PiRun[]>(resolve => { resolveRuns = resolve; }));
    focusListeners.at(-1)!();
    emit({ type: 'run', run: { ...run, generation: 'g2' } });
    rpc({ ...start, attempt: 2 }, { ...run, generation: 'g2' });
    resolveRuns([{ ...run, status: 'idle' }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(usePiStore.getState().runs.find(item => item.key === run.key)).toMatchObject({ status: 'running', generation: 'g2' });
    expect(usePiStore.getState().retrying[run.key]).toMatchObject({ attempt: 2 });
    await vi.advanceTimersByTimeAsync(500);
  });
});
