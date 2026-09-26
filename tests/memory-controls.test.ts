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
    expect(html).not.toContain('<select');
    expect(html).toContain('并非严格隔离');
    expect(html).toContain('正在加载');
    expect(html).not.toContain('此范围暂无记忆文件');
  });
});
