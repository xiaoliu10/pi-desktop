import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AskQuestionCard, parseAskPayload } from '../src/renderer/pi/PiReplicaApp';

const payload = parseAskPayload(JSON.stringify({
  v: 1,
  questions: [
    { header: '实现方案', question: '采用哪种持久化方式？', options: [{ label: 'SQLite', description: '单文件' }, { label: 'JSON' }] },
    { header: '范围', question: '导入哪些？', multiSelect: true, options: [{ label: '全部' }, { label: '最近' }] },
  ],
}))!;

const base = { payload, zh: true, onAnswer: () => {}, onCancel: () => {}, stopTask: () => {}, stopping: false };

describe('desktop-ask 渲染（ZCode ElicitationDialog 交互）', () => {
  it('parses the encoded payload and drops malformed questions', () => {
    expect(payload.questions).toHaveLength(2);
    expect(payload.questions[0].options[0]).toEqual({ label: 'SQLite', description: '单文件' });
    expect(parseAskPayload('not json')).toBeNull();
    expect(parseAskPayload(JSON.stringify({ questions: [{ question: 'q' }] })).questions).toHaveLength(0);
  });

  it('一次一题：首题渲染 + 翻页器 n/N，第二题不与首题同屏', () => {
    const html = renderToStaticMarkup(createElement(AskQuestionCard, base));
    expect(html).toContain('实现方案');
    expect(html).toContain('SQLite');
    expect(html).toContain('单文件');
    expect(html).toContain('1 / 2'); // 翻页器
    expect(html).not.toContain('导入哪些'); // 第二题不堆叠
    expect(html).toContain('继续'); // 非最后题主按钮是「继续」
    expect(html).toContain('使用 Tab / 上下键选择，回车或空格选中');
    expect(html).toContain('输入你的回答'); // 常驻自定义回答行
  });

  it('自定义回答行接续选项编号；多选题渲染方框勾选', () => {
    const html = renderToStaticMarkup(createElement(AskQuestionCard, base));
    // 首题 2 个选项 → 自定义行编号 3.
    expect(html).toContain('>3.<');
    // 多选第二题不在首屏，但 checkbox role 出现在首题行（单选为 option role）
    expect(html).toContain('role="option"');
  });

  it('最后题提交按钮文案为提交；忽略按钮存在', () => {
    const single = parseAskPayload(JSON.stringify({ questions: [{ header: 'H', question: 'Q?', options: [{ label: 'A' }, { label: 'B' }] }] }))!;
    const html = renderToStaticMarkup(createElement(AskQuestionCard, { ...base, payload: single }));
    expect(html).toContain('>提交<');
    expect(html).toContain('忽略');
  });

  it('renders the english variant', () => {
    const html = renderToStaticMarkup(createElement(AskQuestionCard, { ...base, zh: false }));
    expect(html).toContain('Type your answer');
    expect(html).toContain('Continue'); // 多题首屏主按钮是 Continue
    expect(html).toContain('Dismiss');
  });
});
