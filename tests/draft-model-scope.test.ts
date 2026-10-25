import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePiStore } from '../src/renderer/pi/adapter';

// 模型草稿按会话归属隔离：全局单值 draftModelId 会跨会话泄漏——A 会话选的模型
// 会显示在 B 会话并在 B 发送时被下发（2026-10-23 用户实测「一个会话换模型，
// 另一个会话也变了」）。文字草稿早就是按 composerKey 转存的，模型草稿必须同款。
describe('draftModels 按会话隔离', () => {
  const listeners: Array<(e: unknown) => void> = [];
  const history = { session: {}, entries: [], branch: [], leaves: [], leafId: null, syncedAt: 0 };
  const model = vi.fn(async () => undefined);
  const prompt = vi.fn(async () => undefined);
  const connect = vi.fn(async (input: { sourceKey?: string; cwd?: string }) => ({
    key: input.sourceKey === 'kB' ? 'kB-run' : 'new-run', generation: 'g',
    cwd: input.cwd ?? input.sourceKey ?? '/x', file: '/f.jsonl', status: 'idle' as const, models: [], pending: 0, timing: { startedAt: 1 },
  }));
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
    refreshCommands: vi.fn(async () => []),
    thinking: vi.fn(async () => undefined),
    connect, model, prompt,
  };

  beforeAll(async () => {
    (globalThis as Record<string, unknown>).window = { localPi };
    (globalThis as Record<string, unknown>).localStorage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
    usePiStore.getState().init();
    await vi.waitFor(() => expect(listeners.length).toBeGreaterThan(0));
  });

  beforeEach(() => {
    model.mockClear(); prompt.mockClear(); connect.mockClear();
    usePiStore.setState({
      runs: [], selectedKey: 'kA', sentAt: undefined, draftText: '', contextItems: [], draftModels: {},
      notifications: [], toolProgress: {}, pendingSteer: {}, pendingPrompt: undefined, pendingPromptAt: undefined,
    } as never);
  });

  it('两个会话各自选模型互不覆盖', () => {
    usePiStore.setState({ selectedKey: 'kA', runs: [] } as never);
    usePiStore.getState().pickModel('prov/m1');
    usePiStore.setState({ selectedKey: 'kB', runs: [] } as never);
    usePiStore.getState().pickModel('prov/m2');
    const drafts = usePiStore.getState().draftModels ?? {};
    expect(drafts['kA']).toBe('prov/m1');
    expect(drafts['kB']).toBe('prov/m2');
  });

  it('A 选过模型后，B（未选过）发送不得套用 A 的模型', async () => {
    usePiStore.setState({ selectedKey: 'kA', runs: [] } as never);
    usePiStore.getState().pickModel('prov/m1');
    usePiStore.setState({ selectedKey: 'kB', runs: [] } as never);
    usePiStore.getState().send('hi');
    await vi.waitFor(() => expect(connect).toHaveBeenCalled());
    expect(model).not.toHaveBeenCalled();
  });

  it('B 自己选的模型在自己发送时照常下发', async () => {
    usePiStore.setState({ selectedKey: 'kB', runs: [] } as never);
    usePiStore.getState().pickModel('prov/m2');
    usePiStore.getState().send('hi');
    await vi.waitFor(() => expect(model).toHaveBeenCalled());
    expect(model).toHaveBeenCalledWith('kB-run', 'prov', 'm2');
  });

  it('新任务页（home:cwd）选的模型作用于由它新建的会话', async () => {
    usePiStore.setState({ selectedKey: null, draftCwd: '/proj', runs: [] } as never);
    usePiStore.getState().pickModel('prov/m3');
    usePiStore.getState().send('hi');
    await vi.waitFor(() => expect(model).toHaveBeenCalled());
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/proj' }));
    expect(model).toHaveBeenCalledWith('new-run', 'prov', 'm3');
  });

  it('运行中选择：下发 set_model 的同时同步草稿（腾位重连后沿用最近选择）', () => {
    const run = { key: 'kC', generation: 'g', cwd: '/tmp', file: '/c.jsonl', status: 'idle' as const, models: [], pending: 0, timing: { startedAt: 1 } };
    usePiStore.setState({ selectedKey: 'kC', runs: [run] } as never);
    usePiStore.getState().pickModel('prov/m4');
    expect(model).toHaveBeenCalledWith('kC', 'prov', 'm4');
    expect((usePiStore.getState().draftModels ?? {})['kC']).toBe('prov/m4');
  });
});
