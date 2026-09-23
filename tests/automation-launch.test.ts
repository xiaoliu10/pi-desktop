import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { automationLaunchPrompt, usePiStore } from '../src/renderer/pi/adapter';
import { automationPromptText, workflowPrompts, type AutomationRun, type SavedWorkflow } from '../src/shared/automation';

describe('自动化消息拼装（预览与实际发送一致）', () => {
  it('automationPromptText 与 execute 发送格式一致', () => {
    expect(automationPromptText('构建巡检', '构建巡检', 1, 1, '检查构建')).toBe('自动化：构建巡检\n步骤 1/1：构建巡检\n\n检查构建');
    expect(automationPromptText('W', '第二步', 2, 3, 'p')).toBe('自动化：W\n步骤 2/3：第二步\n\np');
  });

  it('workflowPrompts 共享参数替换，预览用同一份逻辑', () => {
    const wf: SavedWorkflow = {
      id: 'w', name: 'W', description: '', whenToUse: '', scope: 'global', cwd: '',
      parameters: [{ name: 'target', type: 'string', description: '', required: true }],
      steps: [{ id: 's1', name: '第一步', prompt: '检查 {{target}}' }],
      updatedAt: 0,
    };
    expect(workflowPrompts(wf, { target: 'src/' })).toEqual(['检查 src/']);
  });
});

describe('automationLaunchPrompt 可见性', () => {
  const launch = { name: '任务', prompt: '自动化：任务', startedAt: 1, sessionKey: undefined as string | undefined };
  it('会话建立前：无选中会话时显示（临时聊天面）', () => {
    expect(automationLaunchPrompt({ automationLaunch: launch, selectedKey: null }, false)).toBe(launch.prompt);
    expect(automationLaunchPrompt({ automationLaunch: launch, selectedKey: 'other' }, false)).toBeUndefined();
  });
  it('会话建立后：只在目标会话显示，真实消息回显后隐藏', () => {
    const launched = { ...launch, sessionKey: 'sess-1' };
    expect(automationLaunchPrompt({ automationLaunch: launched, selectedKey: 'sess-1' }, false)).toBe(launch.prompt);
    expect(automationLaunchPrompt({ automationLaunch: launched, selectedKey: 'sess-1' }, true)).toBeUndefined();
    expect(automationLaunchPrompt({ automationLaunch: launched, selectedKey: 'other' }, false)).toBeUndefined();
  });
  it('无启动状态时恒为空', () => {
    expect(automationLaunchPrompt({ automationLaunch: undefined, selectedKey: null }, false)).toBeUndefined();
  });
});

describe('runAutomationNow 乐观发送流程', () => {
  const listeners: Array<() => void> = [];
  let snapshotRuns: AutomationRun[] = [];
  const localPi = {
    automationRunTask: vi.fn(async () => ({ id: 'run-1' }) as AutomationRun),
    automationSnapshot: vi.fn(async () => ({ tasks: [], workflows: [], runs: snapshotRuns })),
    onAutomationChanged: (fn: () => void) => { listeners.push(fn); return () => { listeners.splice(listeners.indexOf(fn), 1); }; },
  };
  beforeEach(() => {
    listeners.length = 0; snapshotRuns = [];
    localPi.automationRunTask.mockClear(); localPi.automationSnapshot.mockClear();
    (globalThis as Record<string, unknown>).window = { localPi };
    usePiStore.setState({ view: 'automations', selectedKey: 'other', automationLaunch: undefined, error: undefined, sentAt: undefined, history: undefined });
  });
  afterEach(() => { delete (globalThis as Record<string, unknown>).window; });

  it('点击瞬间乐观切入对话（气泡 + 计时起点），会话就绪后切换过去', async () => {
    usePiStore.getState().runAutomationNow({ id: 't1', name: '任务', previewPrompt: '自动化：任务\n步骤 1/1：任务\n\n检查构建' });
    // 不等 IPC：UI 立即有反馈
    expect(usePiStore.getState().view).toBe('chat');
    expect(usePiStore.getState().selectedKey).toBeNull();
    expect(usePiStore.getState().automationLaunch?.prompt).toContain('检查构建');
    expect(automationLaunchPrompt(usePiStore.getState(), false)).toContain('检查构建');
    // run 建立，sessionKey 尚未落 → 仍在临时聊天面
    await vi.waitFor(() => expect(localPi.automationRunTask).toHaveBeenCalledWith('t1'));
    snapshotRuns = [{ id: 'run-1', taskId: 't1', name: '任务', cwd: '/tmp', trigger: 'manual', status: 'running', startedAt: 1, stepIndex: 0, steps: [], sessionKey: 'sess-9' }];
    listeners.forEach(fn => fn());
    await vi.waitFor(() => expect(usePiStore.getState().selectedKey).toBe('sess-9'));
    expect(usePiStore.getState().automationLaunch?.sessionKey).toBe('sess-9');
    expect(usePiStore.getState().sentAt).toMatchObject({ key: 'sess-9' });
  });

  it('启动失败回自动化页并报错，不留悬空气泡', async () => {
    localPi.automationRunTask.mockRejectedValueOnce(new Error('已有运行正在执行，不能重复启动'));
    usePiStore.getState().runAutomationNow({ id: 't1', name: '任务', previewPrompt: 'p' });
    await vi.waitFor(() => expect(usePiStore.getState().view).toBe('automations'));
    expect(usePiStore.getState().automationLaunch).toBeUndefined();
    expect(usePiStore.getState().error).toContain('不能重复启动');
  });
});
