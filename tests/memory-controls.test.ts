import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MemoryBrowser, MemorySwitch } from '../src/renderer/pi/MemoryControls';

describe('memory controls markup', () => {
  it('uses a labelled, disabled-capable switch rather than a range or checkbox', () => {
    const html = renderToStaticMarkup(createElement(MemorySwitch, { enabled: true, disabled: true, onSaved: () => {} }));
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('aria-labelledby="memory-switch-label"');
    expect(html).toContain('disabled=""');
    expect(html).not.toContain('<input');
    expect(html).toContain('全局生效，不随项目独立设置');
  });
  it('includes global and cwd options even without registered projects', () => {
    const html = renderToStaticMarkup(createElement(MemoryBrowser, { cwd: '/mock/current', projects: [] }));
    expect(html).toContain('全局记忆');
    expect(html).toContain('aria-label="记忆项目"');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('current');
    expect(html).toContain('当前浏览范围：项目 · current');
    expect(html).toContain('/mock/current/.pi/memory');
    expect(html).not.toContain('<select');
    expect(html).toContain('项目本地记忆仅来自所选项目 .pi/memory');
    expect(html).toContain('.pi/memory/daily/YYYY-MM-DD.md');
    expect(html).toContain('可能跨项目共用，不属于项目专属记忆');
    expect(html).toContain('不会因摘要路径改变而自动隔离');
    expect(html).toContain('正在加载');
    expect(html).not.toContain('此项目暂无记忆文件');
  });
  it('shows the actual global storage root rather than assuming the default agent directory', () => {
    const html = renderToStaticMarkup(createElement(MemoryBrowser, { projects: [], globalDir: '/custom/agent/memory' }));
    expect(html).toContain('当前浏览范围：全局 · 共享');
    expect(html).toContain('/custom/agent/memory');
    expect(html).not.toContain('~/.pi/agent');
  });
  it('does not invent a global path while memory status is pending', () => {
    const html = renderToStaticMarkup(createElement(MemoryBrowser, { projects: [] }));
    expect(html).toContain('正在确认全局存储路径');
  });
});
