import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parse } from 'postcss';
import { describe, expect, it, vi } from 'vitest';

// The actual xterm renderer is exercised in Chromium; SSR only checks the theme contract.
vi.mock('@xterm/xterm', () => ({ Terminal: class {} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class {} }));
import { TerminalPanel } from '../src/renderer/pi/TerminalPanel';

const css = parse(readFileSync(new URL('../src/renderer/pi/replica-app.css', import.meta.url), 'utf8'));
function declarations(selector: string) {
  const result: Record<string, string> = {};
  css.walkRules(selector, rule => { rule.walkDecls(d => { result[d.prop] = d.value; }); });
  return result;
}

describe('bottom terminal layout', () => {
  it.each([[false, '#ffffff'], [true, '#0d1117']] as const)('shares the xterm theme background with CSS (dark=%s)', (dark, background) => {
    const html = renderToStaticMarkup(createElement(TerminalPanel, { open: true, dark, lang: 'en', onClose() {} }));
    expect(html).toContain(`--pi-terminal-bg:${background}`);
    expect(html).toContain('display:flex');
  });

  it('covers the default black viewport and fractional-row remainder without internal padding', () => {
    expect(declarations('.pi-terminal-panel__term .xterm')).toMatchObject({
      height: '100%', padding: '0', background: 'var(--pi-terminal-bg)',
    });
    expect(declarations('.pi-terminal-panel__term .xterm .xterm-viewport')['background-color']).toBe('var(--pi-terminal-bg)');
    expect(declarations('.pi-terminal-panel__body')).toMatchObject({
      flex: '1', 'min-height': '0', background: 'var(--pi-terminal-bg)',
    });
  });

  it('retains the resizable dock and hides rather than removes the panel', () => {
    expect(declarations('.pi-terminal-panel')).toMatchObject({
      height: 'var(--pi-terminal-height, 300px)', 'flex-shrink': '0',
    });
    const html = renderToStaticMarkup(createElement(TerminalPanel, { open: false, dark: false, lang: 'en', onClose() {} }));
    expect(html).toContain('display:none');
    expect(html).toContain('pi-terminal-panel__body');
  });
});
