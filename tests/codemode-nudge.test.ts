import { describe, expect, it } from 'vitest';
import nudge from '../extensions/desktop-codemode-nudge/index.mjs';

// codemode 采用率引导扩展：系统提示注入可判定规则 + 同轮连续基础工具调用的
// in-flight 提醒（每轮上限 2 次；codemode 脚本内部调用不计数且清零）。

function setup(selectedTools: string[] = ['codemode', 'read', 'bash', 'grep', 'find', 'ls', 'edit', 'write']) {
  const handlers = {};
  const pi = { on(event, handler) { handlers[event] = handler; return () => undefined; } };
  nudge(pi);
  handlers.before_agent_start({ prompt: 'x', systemPromptOptions: { toolGuidelines: {}, selectedTools } });
  return handlers;
}

const result = (toolName: string, parentToolCallId?: string, structuredContent?: unknown) => ({
  type: 'tool_result' as const, toolCallId: 'c1', toolName, parentToolCallId,
  input: {}, content: [{ type: 'text' as const, text: 'out' }], isError: false, structuredContent,
});

describe('codemode nudge：系统提示 guideline 注入', () => {
  it('before_agent_start 把 codemode guideline 替换为可判定规则（2+ 次触发线 + 场景 + 例外），且幂等无累积', () => {
    const handlers = setup();
    const options = { toolGuidelines: {} as Record<string, string[]>, selectedTools: ['codemode'] };
    handlers.before_agent_start({ prompt: 'hi', systemPromptOptions: options });
    handlers.before_agent_start({ prompt: 'hi', systemPromptOptions: options });
    const guidelines = options.toolGuidelines.codemode;
    expect(guidelines).toHaveLength(3); // 替换式赋值：连调两次仍 3 条，无累积
    expect(guidelines.some(g => g.includes('2 or more tool calls'))).toBe(true);
    expect(guidelines.some(g => g.includes('ONE codemode script'))).toBe(true);
    expect(guidelines.some(g => g.includes('Promise.allSettled'))).toBe(true);
    expect(guidelines.some(g => g.includes('single trivial call'))).toBe(true);
  });
});

describe('codemode nudge：in-flight 提醒', () => {
  it('同一轮第 3 次直接基础工具调用触发提醒（content 追加且保留原输出）', () => {
    const handlers = setup();
    handlers.agent_start({});
    expect(handlers.tool_result(result('read'))).toBeUndefined();
    expect(handlers.tool_result(result('bash'))).toBeUndefined();
    const third = handlers.tool_result(result('read'));
    expect(third?.content).toHaveLength(2);
    expect(third?.content[0]).toEqual({ type: 'text', text: 'out' });
    expect((third?.content[1] as { text: string }).text).toContain('codemode nudge');
  });

  it('每轮最多提醒 2 次；agent_start 重置计数与配额', () => {
    const handlers = setup();
    handlers.agent_start({});
    for (let i = 0; i < 3; i += 1) handlers.tool_result(result('read'));
    // 第 6 次调用触发第 2 次提醒（配额内）；第 9 次起配额（2）用尽不再提醒
    expect(handlers.tool_result(result('read'))).toBeUndefined();
    expect(handlers.tool_result(result('read'))).toBeUndefined();
    expect(handlers.tool_result(result('read'))?.content).toHaveLength(2);
    handlers.tool_result(result('read'));
    handlers.tool_result(result('read'));
    expect(handlers.tool_result(result('read'))).toBeUndefined();
    handlers.agent_start({});
    expect(handlers.tool_result(result('read'))).toBeUndefined();
    expect(handlers.tool_result(result('read'))).toBeUndefined();
    expect(handlers.tool_result(result('read'))?.content).toHaveLength(2); // 新一轮重新计到 3
  });

  it('codemode 脚本内部调用（parentToolCallId）不计数且把连续计数清零', () => {
    const handlers = setup();
    handlers.agent_start({});
    handlers.tool_result(result('read'));
    handlers.tool_result(result('bash'));
    handlers.tool_result(result('grep', 'script-1')); // 来自 codemode，不计数
    expect(handlers.tool_result(result('read'))).toBeUndefined(); // streak 已清零，这是第 1 次
  });

  it('codemode 自身的结果清零 streak（已采用后不再反向提醒）', () => {
    const handlers = setup();
    handlers.agent_start({});
    handlers.tool_result(result('read'));
    handlers.tool_result(result('bash'));
    handlers.tool_result(result('codemode'));
    expect(handlers.tool_result(result('read'))).toBeUndefined(); // 清零后这是第 1 次
  });

  it('codemode 不在 selectedTools 时运行中提醒静默关闭（系统提示层本就不渲染）', () => {
    const handlers = setup(['read', 'bash', 'grep']);
    handlers.agent_start({});
    handlers.tool_result(result('read'));
    handlers.tool_result(result('bash'));
    expect(handlers.tool_result(result('read'))).toBeUndefined();
  });

  it('nudged bash 结果透传 structuredContent（运行时契约：返回 content 即整体替换，不透传会删机器可读输出）', () => {
    const handlers = setup();
    handlers.agent_start({});
    handlers.tool_result(result('read'));
    handlers.tool_result(result('bash'));
    const structured = { output: 'machine-readable' };
    const nudged = handlers.tool_result(result('bash', undefined, structured));
    expect(nudged?.content).toHaveLength(2);
    expect(nudged?.structuredContent).toBe(structured);
  });

  it('非基础工具（如 ask_user_question）不打断也不计数', () => {
    const handlers = setup();
    handlers.agent_start({});
    handlers.tool_result(result('read'));
    handlers.tool_result(result('bash'));
    handlers.tool_result(result('ask_user_question'));
    expect(handlers.tool_result(result('read'))?.content).toHaveLength(2); // 基础工具连续 3 次照常触发
  });
});
