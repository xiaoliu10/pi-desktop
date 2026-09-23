import { describe, expect, it } from 'vitest';
import desktopAsk from '../extensions/desktop-ask/index.mjs';

function loadTool() {
  let tool: any;
  desktopAsk({ registerTool: (t: any) => { tool = t; } });
  return tool;
}

const QUESTIONS = [
  {
    header: '实现方案',
    question: '采用哪种持久化方式？',
    options: [
      { label: 'SQLite', description: '单文件，零运维' },
      { label: 'JSON 文件', description: '简单直接' },
    ],
  },
  {
    header: '导入范围',
    question: '导入哪些会话？',
    multiSelect: true,
    options: [{ label: '全部' }, { label: '最近 30 天' }, { label: '仅置顶' }],
  },
];

describe('desktop-ask ask_user_question', () => {
  it('registers with a valid schema and returns parsed answers', async () => {
    const tool = loadTool();
    expect(tool.name).toBe('ask_user_question');
    expect(tool.parameters.properties.questions.maxItems).toBe(4);
    const ctx = { ui: { input: async (_t: string, payload: string) => JSON.stringify([{ header: '实现方案', answers: ['SQLite'] }, { header: '导入范围', answers: ['全部', '仅置顶'] }]) }, signal: undefined };
    const result = await tool.execute('t1', { questions: QUESTIONS }, undefined, undefined, ctx);
    expect(result.details.answers).toHaveLength(2);
    expect(result.content[0].text).toContain('实现方案: SQLite');
    expect(result.content[0].text).toContain('导入范围: 全部、仅置顶');
  });

  it('encodes the payload for the desktop renderer via ui.input', async () => {
    const tool = loadTool();
    let captured: { title: string; payload: string } | null = null;
    const ctx = { ui: { input: async (title: string, payload: string) => { captured = { title, payload }; return '[]'; } }, signal: undefined };
    await tool.execute('t1', { questions: QUESTIONS }, undefined, undefined, ctx);
    expect(captured!.title).toBe('desktop-ask');
    const payload = JSON.parse((captured as any).payload);
    expect(payload.v).toBe(1);
    expect(payload.questions[0].options[0]).toEqual({ label: 'SQLite', description: '单文件，零运维' });
  });

  it('reports cancellation when aborted or dismissed', async () => {
    const tool = loadTool();
    const noUi = { ui: { input: async () => { throw new Error('should not be called'); } } };
    const cancelResult = await tool.execute('t1', { questions: QUESTIONS }, { aborted: true }, undefined, noUi);
    expect(cancelResult.details.cancelled).toBe(true);
    const dismissed = { ui: { input: async () => undefined } };
    const dismissResult = await tool.execute('t1', { questions: QUESTIONS }, undefined, undefined, dismissed);
    expect(dismissResult.details.cancelled).toBe(true);
  });

  it('falls back to numeric replies from a plain TUI', async () => {
    const tool = loadTool();
    const ctx = { ui: { input: async () => '1' }, signal: undefined };
    const single = await tool.execute('t1', { questions: [QUESTIONS[0]] }, undefined, undefined, ctx);
    expect(single.content[0].text).toContain('实现方案: SQLite');
    const ctx2 = { ui: { input: async () => '1, 3' }, signal: undefined };
    const multi = await tool.execute('t1', { questions: [QUESTIONS[1]] }, undefined, undefined, ctx2);
    expect(multi.content[0].text).toContain('导入范围: 全部、仅置顶');
  });

  it('rejects malformed payloads', async () => {
    const tool = loadTool();
    const ctx = { ui: { input: async () => '[]' }, signal: undefined };
    await expect(tool.execute('t1', { questions: [] }, undefined, undefined, ctx)).rejects.toThrow('1-4 个问题');
    await expect(tool.execute('t1', { questions: [{ question: 'q', options: [{ label: 'a' }] }] }, undefined, undefined, ctx)).rejects.toThrow('2-4 个选项');
    await expect(tool.execute('t1', { questions: [{ question: '  ', options: [{ label: 'a' }, { label: 'b' }] }] }, undefined, undefined, ctx)).rejects.toThrow('question');
  });

  it('handles invalid user replies gracefully', async () => {
    const tool = loadTool();
    const ctx = { ui: { input: async () => '不是json也不是数字' }, signal: undefined };
    const result = await tool.execute('t1', { questions: QUESTIONS }, undefined, undefined, ctx);
    expect(result.details.answers).toEqual([]);
    expect(result.content[0].text).toContain('最佳判断');
  });
});
