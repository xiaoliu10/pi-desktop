import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ExecutionNote } from '../src/renderer/replica/chat/ChatView';

// 折叠态摘要（流式 ticker）不得泄漏 markdown 字面符号；正文（展开时）走 markdown 渲染。
// 详情子树按需渲染（perf 契约）：折叠时 body 不在 DOM——这两个测试用 defaultOpen 钉正文路径。
describe('thinking excerpt plain text', () => {
  it('does not leak literal markdown ** in the active summary ticker', () => {
    const html = renderToStaticMarkup(createElement(ExecutionNote, { title: '思考', text: '**Investigating SDK support**', active: true, zh: true }));
    expect(html).toContain('Investigating SDK support');
    expect(html).not.toContain('**');
  });
  it('renders the body via markdown when opened (bold resolved, no literal asterisks)', () => {
    const html = renderToStaticMarkup(createElement(ExecutionNote, { title: '思考', text: '**Investigating SDK support**', defaultOpen: true, zh: true }));
    expect(html).toContain('Investigating SDK support');
    expect(html).toContain('<strong>');
    expect(html).not.toContain('**');
  });
  it('keeps inline code backticks out of every path (collapsed shows nothing, body resolves code)', () => {
    const text = 'Looking at `parseContextPrompt` to round-trip.';
    const collapsed = renderToStaticMarkup(createElement(ExecutionNote, { title: '思考', text, zh: true }));
    // 折叠态是纯 summary（perf 契约：正文不进 DOM），不露任何正文与字面反引号
    expect(collapsed).not.toContain('parseContextPrompt');
    expect(collapsed).not.toMatch(/`parseContextPrompt`/);
    const open = renderToStaticMarkup(createElement(ExecutionNote, { title: '思考', text, defaultOpen: true, zh: true }));
    expect(open).toContain('parseContextPrompt'); // 正文经 markdown 渲染（<code>），无字面反引号
    expect(open).not.toMatch(/`parseContextPrompt`/);
  });
});
