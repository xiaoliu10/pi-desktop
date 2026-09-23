import { describe, expect, it } from 'vitest';
import { handleMessage, parseCommand, type BotActions } from '../src/main/pi/bot/engine';

function fakeActions(over: Partial<BotActions> = {}): BotActions & { prompts: string[]; models: string[] } {
  const models = ['openai/gpt-5.4-mini', 'anthropic/claude-opus-4'];
  const state = {
    prompts: [] as string[],
    models,
    projects: ['/Users/jason/work/pi-desktop', '/Users/jason/work/blog'],
    mode: 'followUp' as string,
  };
  const actions: BotActions & { prompts: string[]; models: string[] } = {
    prompts: state.prompts,
    get models() { return state.models; },
    async status(cwd) { return `状态@${cwd ?? 'none'}`; },
    async listProjects() { return state.projects; },
    async listModels() { return [...state.models]; },
    async switchModel(index) { state.models = [state.models[index], ...state.models.slice(0, index), ...state.models.slice(index + 1)]; return `切换到 ${state.models[0]}`; },
    async newTask(cwd) { return `新任务@${cwd ?? 'none'}`; },
    async setThinking(level) { return `思考=${level}`; },
    async prompt(text) { state.prompts.push(text); return `已发送:${text}`; },
    modes() { return ['followUp', 'steer']; },
    async setMode(mode) { state.mode = mode; return `模式=${mode}`; },
    thinkingLevels() { return ['off', 'low', 'high']; },
    promptAllowed() { return true; },
    ...over,
  };
  return actions;
}

describe('parseCommand', () => {
  it('splits command and args, chinese and english', () => {
    expect(parseCommand('/帮助')).toEqual({ cmd: '帮助', args: '' });
    expect(parseCommand('/模型 2')).toEqual({ cmd: '模型', args: '2' });
    expect(parseCommand('/项目 blog')).toEqual({ cmd: '项目', args: 'blog' });
  });

  it('returns empty for plain text', () => {
    expect(parseCommand('帮我看看这个 bug')).toEqual({ cmd: '', args: '' });
  });
});

describe('handleMessage', () => {
  it('help lists the command surface', async () => {
    const reply = await handleMessage('/帮助', 'chat1', {}, fakeActions());
    expect(reply).toContain('/状态');
    expect(reply).toContain('/bind');
  });

  it('bind then free text prompts the bound workspace', async () => {
    const actions = fakeActions();
    const bindings = {};
    expect(await handleMessage('/bind', 'chat1', bindings, actions)).toContain('pi-desktop');
    const reply = await handleMessage('修复登录 bug', 'chat1', bindings, actions);
    expect(reply).toContain('已发送:修复登录 bug');
    expect(actions.prompts).toEqual(['修复登录 bug']);
  });

  it('free text without binding asks for /bind', async () => {
    const reply = await handleMessage('hi', 'chatX', {}, fakeActions());
    expect(reply).toContain('/bind');
  });

  it('switches workspace by name and by index', async () => {
    const bindings = {};
    expect(await handleMessage('/项目 blog', 'c', bindings, fakeActions())).toContain('blog');
    expect(bindings.c.cwd).toBe('/Users/jason/work/blog');
    expect(await handleMessage('/项目 1', 'c2', bindings, fakeActions())).toContain('pi-desktop');
    expect(bindings.c2.cwd).toBe('/Users/jason/work/pi-desktop');
  });

  it('lists and switches models by index', async () => {
    const actions = fakeActions();
    const list = await handleMessage('/模型', 'c', {}, actions);
    expect(list).toContain('1. openai/gpt-5.4-mini');
    const switched = await handleMessage('/模型 2', 'c', {}, actions);
    expect(switched).toContain('claude-opus-4');
  });

  it('new task binds automatically when unbound', async () => {
    const bindings = {};
    const reply = await handleMessage('/新建', 'c', bindings, fakeActions());
    expect(reply).toContain('新任务@/Users/jason/work/pi-desktop');
    expect(bindings.c.cwd).toBe('/Users/jason/work/pi-desktop');
  });

  it('thinking validates levels', async () => {
    expect(await handleMessage('/思考 high', 'c', {}, fakeActions())).toBe('思考=high');
    expect(await handleMessage('/思考', 'c', {}, fakeActions())).toContain('off / low / high');
    expect(await handleMessage('/思考 ultra', 'c', {}, fakeActions())).toContain('无效级别');
  });

  it('mode toggles without args', async () => {
    const actions = fakeActions();
    const bindings = {};
    // unset → first mode in the list
    const first = await handleMessage('/模式', 'c', bindings, actions);
    expect(first).toBe('模式=followUp');
    expect(bindings.c.mode).toBe('followUp');
    // toggle → next mode wraps around the list
    const second = await handleMessage('/模式', 'c', bindings, actions);
    expect(second).toBe('模式=steer');
    // explicit arg
    expect(await handleMessage('/模式 followUp', 'c', bindings, actions)).toBe('模式=followUp');
  });

  it('unknown commands get a hint', async () => {
    expect(await handleMessage('/不存在', 'c', {}, fakeActions())).toContain('未知命令');
  });
});
