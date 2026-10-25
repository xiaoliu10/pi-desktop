import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChatView } from '../src/renderer/replica/chat/ChatView';
import { replicaLabels } from '../src/renderer/replica/i18n';
import { parseFileReference } from '../src/renderer/replica/chat/file-references';

const render = (text: string) => renderToStaticMarkup(createElement(ChatView, {
  messages: [{ id: 'file-answer', role: 'assistant', parts: [{ kind: 'text', id: 'file-text', text }] }],
  running: false, queued: 0, demo: false, labels: replicaLabels('zh').chat,
  onJumpToMessage: () => {}, onOpenFile: () => {},
}));

describe('file reference parsing', () => {
  it.each([
    ['docs/design/research/claude-code-architecture.md', { path: 'docs/design/research/claude-code-architecture.md' }],
    ['src/main/index.ts:42:3', { path: 'src/main/index.ts', line: 42 }],
    ['docs/guide.md#L12-L19', { path: 'docs/guide.md', line: 12 }],
    ['/tmp/research/report.md', { path: '/tmp/research/report.md' }],
    ['C:\\work\\docs\\report.md:10', { path: 'C:\\work\\docs\\report.md', line: 10 }],
    ['README.md', { path: 'README.md' }],
    ['README.md:42', { path: 'README.md', line: 42 }],
    ['docs/my report.md', { path: 'docs/my report.md' }],
  ])('parses %s', (input, expected) => expect(parseFileReference(input)).toEqual(expected));
  it.each(['https://example.com/docs.md', '//example.com/guide.md', 'javascript:alert(1)', 'file:///tmp/report.md', 'data:text/plain,x', '#section', '/api/daily/activity', 'npm install docs/guide.md', 'cat src/main.ts', 'src/*.ts', 'foo.bar', 'example.com', 'report.md\u0000'])('rejects non-file reference %s', input => expect(parseFileReference(input)).toBeNull());
  it('decodes explicit link destinations once and rejects encoded schemes/control characters', () => {
    expect(parseFileReference('docs/my%20report.md#L8', true)).toEqual({ path: 'docs/my report.md', line: 8 });
    for (const input of ['https%3A%2F%2Fexample.com/a.md', 'docs/a%00.md', 'docs/%ZZ.md']) expect(parseFileReference(input, true)).toBeNull();
  });
});

describe('chat file reference rendering', () => {
  it('makes the screenshot inline-code path actionable in the real conversation tree', () => {
    const html = render('调研完成。产出：`docs/design/research/claude-code-architecture.md`');
    expect(html).toContain('data-file-path="docs/design/research/claude-code-architecture.md"');
    expect(html).toContain('在右侧查看文件');
  });
  it('supports explicit local Markdown links and line references', () => {
    const html = render('[设计文档](docs/design/research/claude-code-architecture.md) 和 `src/main/index.ts:42:3`');
    expect(html).toContain('data-file-path="docs/design/research/claude-code-architecture.md"');
    expect(html).toContain('data-file-path="src/main/index.ts"');
    expect(html).toContain('data-file-line="42"');
  });
  it('does not turn fenced code, shell commands, URLs or identifiers into local file actions', () => {
    const html = render('~~~ts\nsrc/main/index.ts\n~~~\n\n`npm install foo` `https://example.com/docs.md` `example.com` `foo.bar`');
    expect(html).not.toContain('data-file-path=');
  });
  it('does not nest actions in links or images and keeps external URLs external', () => {
    const html = render('[`docs/guide.md`](https://example.com) ![docs/guide.md](shot.png)');
    expect(html).not.toContain('data-file-path=');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank"');
  });
});
