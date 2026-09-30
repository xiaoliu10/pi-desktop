import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePiStore } from '../src/renderer/pi/adapter';

// agent_settled 计时条兜底：run 状态事件丢失（重排/pi 重启）时 renderer 会把 run
// 卡在 running、或 sentAt 残留使 idle 下 sending 恒真——工作条按发送时刻永续计时。
// 兜底逻辑必须把两者拉直。
describe('agent_settled 拉直卡死的计时状态', () => {
  const listeners: Array<(e: unknown) => void> = [];
  const history = { session: {}, entries: [], branch: [], leaves: [], leafId: null, syncedAt: 0 };
  const localPi = {
    onEvent: (fn: (e: unknown) => void) => { listeners.push(fn); return () => undefined; },
    settingsSnapshot: vi.fn(async () => ({ preferences: { behavior: 'followUp', permission: 'ask', shortcuts: {}, projects: [] }, ai: {}, resources: [], mcp: [], mcpRevisions: {}, diagnostics: [], projects: [], loadedExtensions: [] })),
    environment: vi.fn(async () => ({ supported: true, version: '0.87.0' })),
    sessions: vi.fn(async () => []),
    runs: vi.fn(async () => []),
    archivedSessions: vi.fn(async () => []),
    history: vi.fn(async () => history),
    recoverSubagents: vi.fn(async () => []),
  };

  beforeAll(async () => {
    (globalThis as Record<string, unknown>).window = { localPi };
    (globalThis as Record<string, unknown>).localStorage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
    usePiStore.getState().init(); // init 有 started 单次守卫，只在 beforeAll 订阅一次
    await vi.waitFor(() => expect(listeners.length).toBeGreaterThan(0));
  });

  beforeEach(() => {
    usePiStore.setState({ runs: [], sentAt: undefined, selectedKey: 'k1', retrying: {}, toolProgress: {}, pendingSteer: {}, pendingPrompt: undefined, pendingPromptAt: undefined } as never);
  });

  const seedStuck = () => usePiStore.setState({
    runs: [{ key: 'k1', generation: 'g1', cwd: '/tmp', file: '/tmp/a.jsonl', status: 'running', models: [], pending: 0, timing: { startedAt: 1 } }],
    sentAt: { key: 'k1', at: 1 },
  } as never);

  it('agent_settled 把卡在 running 的 run 拉直为 idle 并清掉 sentAt', async () => {
    seedStuck();
    listeners[0]!({ type: 'rpc', key: 'k1', generation: 'g1', event: { type: 'agent_settled' } });
    await vi.waitFor(() => expect(usePiStore.getState().runs.find(r => r.key === 'k1')?.status).toBe('idle'));
    expect(usePiStore.getState().sentAt).toBeUndefined();
  });

  it('队列还有待发项时不强行拉直（避免排队流闪烁）', () => {
    usePiStore.setState({
      runs: [{ key: 'k1', generation: 'g1', cwd: '/tmp', file: '/tmp/a.jsonl', status: 'running', models: [], pending: 1, queue: [{ text: '排队', behavior: 'followUp' }] }],
      sentAt: { key: 'k1', at: 1 },
    } as never);
    listeners[0]!({ type: 'rpc', key: 'k1', generation: 'g1', event: { type: 'agent_settled' } });
    expect(usePiStore.getState().runs.find(r => r.key === 'k1')?.status).toBe('running');
  });

  it('closed 清掉对应会话的 sentAt（重连后 idle 会话不再恒显工作条）', () => {
    seedStuck();
    listeners[0]!({ type: 'closed', key: 'k1', generation: 'g1' });
    expect(usePiStore.getState().sentAt).toBeUndefined();
  });

  // 后端假 running 自愈：run 事件从运行态翻 idle（同代）时按 agent_settled 同语义收尾，
  // 否则后端拉直了 run、渲染层的历史/孤儿气泡仍停留在事件丢失的那一轮。
  it('run 事件 running→idle（同代）合成 settle：清 sentAt、撤孤儿气泡', async () => {
    seedStuck();
    const orphan = { id: 's1', key: 'k1', at: 1, text: '丢了结算的任务', images: [], baseline: [], promptDone: true };
    usePiStore.setState({ sends: [orphan] } as never);
    listeners[0]!({ type: 'run', run: { key: 'k1', generation: 'g1', cwd: '/tmp', file: '/tmp/a.jsonl', status: 'idle', models: [], pending: 0 } });
    await vi.waitFor(() => {
      const s = usePiStore.getState();
      expect(s.runs.find(r => r.key === 'k1')?.status).toBe('idle');
      expect(s.sentAt).toBeUndefined();
      expect((s.sends ?? []).length).toBe(0);
    });
  });

  it('跨代 run 事件（重连新运行时）不合成 settle', async () => {
    seedStuck();
    const orphan = { id: 's2', key: 'k1', at: 1, text: '旧代任务', images: [], baseline: [], promptDone: true };
    usePiStore.setState({ sends: [orphan] } as never);
    listeners[0]!({ type: 'run', run: { key: 'k1', generation: 'g2', cwd: '/tmp', file: '/tmp/a.jsonl', status: 'idle', models: [], pending: 0 } });
    await new Promise(r => setTimeout(r, 50));
    const s = usePiStore.getState();
    expect((s.sends ?? []).some(x => x.id === 's2')).toBe(true);
  });
});
