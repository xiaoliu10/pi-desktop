import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePiStore } from '../src/renderer/pi/adapter';

// 内置 /new（pi CLI 同款）：TUI 命令，RPC prompt 不解析，不拦截会被当普通消息发给模型。
// Desktop 等价 = 新任务按钮（⌘⇧N）的 startNewSession()；附带文本作为新任务草稿，附件保留。
describe('/new 拦截路由到 startNewSession', () => {
  const listeners: Array<(e: unknown) => void> = [];
  const history = { session: {}, entries: [], branch: [], leaves: [], leafId: null, syncedAt: 0 };
  const prompt = vi.fn(async () => undefined);
  const localPi = {
    onEvent: (fn: (e: unknown) => void) => { listeners.push(fn); return () => undefined; },
    settingsSnapshot: vi.fn(async () => ({ preferences: { behavior: 'followUp', permission: 'ask', shortcuts: {}, projects: [] }, ai: {}, resources: [], mcp: [], mcpRevisions: {}, diagnostics: [], projects: [], loadedExtensions: [] })),
    environment: vi.fn(async () => ({ supported: true, version: '0.87.0', sessionDirs: [] })),
    modelCatalog: vi.fn(async () => ({ providers: [] })),
    resources: vi.fn(async () => []),
    packageList: vi.fn(async () => []),
    sessions: vi.fn(async () => []),
    runs: vi.fn(async () => []),
    archivedSessions: vi.fn(async () => []),
    history: vi.fn(async () => history),
    recoverSubagents: vi.fn(async () => []),
    prompt,
  };

  beforeAll(async () => {
    (globalThis as Record<string, unknown>).window = { localPi };
    (globalThis as Record<string, unknown>).localStorage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
    usePiStore.getState().init();
    await vi.waitFor(() => expect(listeners.length).toBeGreaterThan(0));
  });

  beforeEach(() => {
    prompt.mockClear();
    usePiStore.setState({
      runs: [{ key: 'k1', generation: 'g1', cwd: '/tmp', file: '/tmp/a.jsonl', status: 'idle', models: [], pending: 0, timing: { startedAt: 1 } }],
      selectedKey: 'k1', sentAt: undefined, draftText: '/new', contextItems: [],
      notifications: [], toolProgress: {}, pendingSteer: {}, pendingPrompt: undefined, pendingPromptAt: undefined,
    } as never);
  });

  it('/new 回到新任务页，命令文本不残留、不进 prompt', () => {
    usePiStore.getState().send('/new');
    expect(usePiStore.getState().selectedKey).toBeNull();
    expect(usePiStore.getState().view).toBe('home');
    expect(usePiStore.getState().draftText).toBe('');
    expect(prompt).not.toHaveBeenCalled();
  });

  it('/new 带附带文本：作为新任务草稿带入输入框', () => {
    usePiStore.getState().send('/new 帮我写周报');
    expect(usePiStore.getState().selectedKey).toBeNull();
    expect(usePiStore.getState().view).toBe('home');
    expect(usePiStore.getState().draftText).toBe('帮我写周报');
    expect(prompt).not.toHaveBeenCalled();
  });

  it('/new 保留已添加的附件', () => {
    const items = [{ id: 'c1', name: 'a.txt', path: '/tmp/a.txt', kind: 'file' as const, text: 'x' }];
    usePiStore.setState({ contextItems: items } as never);
    usePiStore.getState().send('/new');
    expect(usePiStore.getState().contextItems).toHaveLength(1);
    expect(usePiStore.getState().contextItems[0].id).toBe('c1');
  });

  it('/new 前置空白与尾部空格也识别', () => {
    usePiStore.getState().send('  /new  ');
    expect(usePiStore.getState().selectedKey).toBeNull();
    expect(usePiStore.getState().draftText).toBe('');
  });

  it('已在首页时 /new 只是清掉命令文本，不产生错误', () => {
    usePiStore.setState({ selectedKey: null, view: 'home', draftCwd: '/tmp' } as never);
    usePiStore.getState().send('/new');
    expect(usePiStore.getState().view).toBe('home');
    expect(usePiStore.getState().draftText).toBe('');
    expect(usePiStore.getState().error).toBeUndefined();
  });

  it('非 /new 文本（如 /newspaper）照常走 prompt', () => {
    usePiStore.setState({ connecting: false } as never);
    usePiStore.getState().send('/newspaper 说明');
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(usePiStore.getState().selectedKey).toBe('k1');
  });
});
