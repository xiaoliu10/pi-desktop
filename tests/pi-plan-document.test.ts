import { describe, expect, it } from 'vitest';
import { planDocument, planDocumentTitle, planFromMarkdown } from '../src/renderer/pi/plan-document';
import type { ChatMessage } from '../src/renderer/replica/contracts';

const text = (id: string, value: string) => ({ kind: 'text' as const, id, text: value });
const assistant = (...parts: ChatMessage['parts']): ChatMessage => ({ id: 'a', role: 'assistant', parts, ts: 0 });
const user = (value: string): ChatMessage => ({ id: 'u', role: 'user', parts: [text('t', value)], ts: 0 });

describe('planDocumentTitle', () => {
  it('取首个 H1 作为计划标题', () => {
    expect(planDocumentTitle('前言\n\n# 重构登录模块\n\n## 步骤')).toBe('重构登录模块');
  });

  it('没有 H1 时取首个非空文本行并去掉装饰前缀', () => {
    expect(planDocumentTitle('\n> 引用行\n正文')).toBe('引用行');
    expect(planDocumentTitle('- 列表当标题')).toBe('列表当标题');
  });

  it('空文档回退到默认标题', () => {
    expect(planDocumentTitle('   \n')).toBe('计划');
    expect(planDocumentTitle('', 'Plan')).toBe('Plan');
  });

  it('超长标题截断', () => {
    const long = '长'.repeat(120);
    expect(planDocumentTitle(`# ${long}`)).toHaveLength(80);
    expect(planDocumentTitle(`# ${long}`).endsWith('…')).toBe(true);
  });
});

describe('planDocument', () => {
  it('取最后一条含正文的助手消息作为计划文档', () => {
    const messages = [
      user('帮我规划重构'),
      assistant(text('1', '旧的草稿')),
      assistant(text('2', '# 最终计划\n\n第一步')),
    ];
    expect(planDocument(messages)).toEqual({ title: '最终计划', markdown: '# 最终计划\n\n第一步' });
  });

  it('跳过纯工具调用的助手消息，回溯到上一条文本', () => {
    const messages = [
      user('规划'),
      assistant(text('1', '# 计划 A')),
      assistant({ kind: 'tool' as never }),
    ];
    expect(planDocument(messages)?.markdown).toBe('# 计划 A');
  });

  it('纯空白正文不当作文档', () => {
    expect(planDocument([user('规划'), assistant(text('1', '  \n'))])).toBeNull();
  });

  it('多条文本段用空行连接', () => {
    const doc = planDocument([assistant(text('a', '第一段'), text('b', '第二段'))]);
    expect(doc?.markdown).toBe('第一段\n\n第二段');
  });
});

describe('planFromMarkdown', () => {
  it('由快照还原文档', () => {
    expect(planFromMarkdown('# 快照标题\n内容')).toEqual({ title: '快照标题', markdown: '# 快照标题\n内容' });
  });
});
