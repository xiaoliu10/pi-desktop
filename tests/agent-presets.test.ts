import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEFAULT_AGENT_PRESETS } from '../src/shared/settings';
import { HomeView } from '../src/renderer/replica/chat/ChatView';

describe('agentPresets', () => {
  it('ships four usable defaults', () => {
    expect(DEFAULT_AGENT_PRESETS).toHaveLength(4);
    expect(new Set(DEFAULT_AGENT_PRESETS.map((p) => p.id)).size).toBe(4);
    for (const p of DEFAULT_AGENT_PRESETS) {
      expect(p.label.trim()).not.toBe('');
      expect(p.prompt.trim()).not.toBe('');
      expect(p.icon.trim()).not.toBe('');
    }
  });

  it('HomeView renders the preset pills below the composer', () => {
    const html = renderToStaticMarkup(createElement(HomeView, {
      greeting: '晚上好，今天辛苦啦',
      composer: null,
      presets: DEFAULT_AGENT_PRESETS.map((p) => ({ id: p.id, label: p.label, icon: p.icon as never })),
      onPickPreset: () => undefined,
    }));
    for (const label of DEFAULT_AGENT_PRESETS.map((p) => p.label)) expect(html).toContain(label);
    expect(html).toContain('pi-home__presets');
  });

  it('HomeView omits the pill row when no presets are configured', () => {
    const html = renderToStaticMarkup(createElement(HomeView, { greeting: 'hi', composer: null }));
    expect(html).not.toContain('pi-home__presets');
  });
});
