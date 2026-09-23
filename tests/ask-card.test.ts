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

describe('desktop-ask 渲染', () => {
  it('parses the encoded payload and drops malformed questions', () => {
    expect(payload.questions).toHaveLength(2);
    expect(payload.questions[0].options[0]).toEqual({ label: 'SQLite', description: '单文件' });
    expect(parseAskPayload('not json')).toBeNull();
    expect(parseAskPayload(JSON.stringify({ questions: [{ question: 'q' }] }))).toEqual({ questions: [] });
  });

  it('renders question cards with options, descriptions and an Other free-text row', () => {
    const html = renderToStaticMarkup(createElement(AskQuestionCard, {
      payload, zh: true, onAnswer: () => {}, onCancel: () => {}, stopTask: () => {}, stopping: false,
    }));
    expect(html).toContain('实现方案');
    expect(html).toContain('SQLite');
    expect(html).toContain('单文件');
    expect(html).toContain('可多选');
    expect(html).toContain('其他');
    expect(html).toContain('提交');
    expect(html).toContain('disabled'); // 未作答时提交不可用
  });

  it('renders the english variant', () => {
    const html = renderToStaticMarkup(createElement(AskQuestionCard, {
      payload, zh: false, onAnswer: () => {}, onCancel: () => {}, stopTask: () => {}, stopping: false,
    }));
    expect(html).toContain('Other');
    expect(html).toContain('Submit');
  });
});
