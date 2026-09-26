import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePiStore } from '../src/renderer/pi/adapter';

// 内置 /compact：TUI 专用命令，pi RPC 的 prompt() 不解析（get_commands 也不含内置命令），
// 不拦截就会被当普通消息发给模型。Desktop 在 send() 拦截并路由到 RPC 专用 compact 命令。
describe('/compact 拦截路由到 RPC compact 命令', () => {
  const listeners: Array<(e: unknown) => void> = [];
  const history = { session: {}, entries: [], branch: [], leaves: [], leafId: null, syncedAt: 0 };
  const compact = vi.fn(async () => ({ summary: '摘要', tokensBefore: 123_456 }));
  const prompt = vi.fn(async () => undefined);
  const localPi = {
    onEvent: (fn: (e: unknown) => void) => { listeners.push(fn); return () => undefined; },
    settingsSnapshot: vi.fn(async () => ({ preferences: { behavior: 'followUp', permission: 'ask', shortcuts: {}, projects: [] }, ai: {}, resources: [], mcp: [], mcpRevisions: {}, diagnostics: [], projects: [], loadedExtensions: [] })),
    environment: vi.fn(async () => ({ supported: true, version: '0.87.0' })),
    sessions: vi.fn(async () => []),
    runs: vi.fn(async () => []),
    archivedSessions: vi.fn(async () => []),
    history: vi.fn(async () => history),
    recoverSubagents: vi.fn(async () => []),
    compact,
    prompt,
  };

  beforeAll(async () => {
    (globalThis as Record<string, unknown>).window = { localPi };
    (globalThis as Record<string, unknown>).localStorage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
    usePiStore.getState().init();
    await vi.waitFor(() => expect(listeners.length).toBeGreaterThan(0));
  });

  beforeEach(() => {
    compact.mockClear(); prompt.mockClear();
    usePiStore.setState({
      runs: [{ key: 'k1', generation: 'g1', cwd: '/tmp', file: '/tmp/a.jsonl', status: 'idle', models: [], pending: 0, timing: { startedAt: 1 } }],
      selectedKey: 'k1', sentAt: undefined, draftText: '/compact', contextItems: [],
      notifications: [], toolProgress: {}, pendingSteer: {}, pendingPrompt: undefined, pendingPromptAt: undefined,
    } as never);
  });

  it('/compact 走专用命令且不进 prompt', async () => {
    usePiStore.getState().send('/compact');
    await vi.waitFor(() => expect(compact).toHaveBeenCalledTimes(1));
    expect(compact).toHaveBeenCalledWith('k1', undefined);
    expect(prompt).not.toHaveBeenCalled();
    // 草稿即清空；完成后刷新历史带回压缩记录
    expect(usePiStore.getState().draftText).toBe('');
    await vi.waitFor(() => expect(usePiStore.getState().notifications.some((n) => n.title.includes('上下文已压缩'))).toBe(true));
  });

  it('/compact 自定义指令原样透传', async () => {
    usePiStore.getState().send('/compact 保留关键决策与未完成事项');
    await vi.waitFor(() => expect(compact).toHaveBeenCalledTimes(1));
    expect(compact).toHaveBeenCalledWith('k1', '保留关键决策与未完成事项');
    expect(prompt).not.toHaveBeenCalled();
  });

  it('运行中拒绝压缩并提示', () => {
    usePiStore.setState({ runs: [{ key: 'k1', generation: 'g1', cwd: '/tmp', file: '/tmp/a.jsonl', status: 'running', models: [], pending: 0, timing: { startedAt: 1 } }] } as never);
    usePiStore.getState().send('/compact');
    expect(compact).not.toHaveBeenCalled();
    expect(usePiStore.getState().error).toContain('空闲');
    // 草稿保留，用户可稍后重试
    expect(usePiStore.getState().draftText).toBe('/compact');
  });

  it('非 compact 文本照常走 prompt', () => {
    usePiStore.setState({ connecting: false } as never);
    usePiStore.getState().send('/compactify 我的说明');
    expect(compact).not.toHaveBeenCalled();
    expect(prompt).toHaveBeenCalledTimes(1);
  });
});
