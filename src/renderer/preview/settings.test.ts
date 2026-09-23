import { beforeEach, describe, expect, it } from 'vitest';
import { filterNavSections, filterRows, validateProviderForm } from '../replica/settings/helpers';
import { demoSettingsNav } from './fixtures';
import { useDemoStore } from './adapter';

describe('U05 settings navigation & filtering', () => {
  it('filters nav items by query, dropping empty sections', () => {
    const nav = demoSettingsNav('en');
    const models = filterNavSections(nav, 'models');
    expect(models).toHaveLength(1);
    expect(models[0].items.map((i) => i.id)).toEqual(['models']);
    expect(filterNavSections(nav, '')).toHaveLength(nav.length);
    expect(filterNavSections(nav, 'zzz')).toHaveLength(0);
  });

  it('filters setting rows by title/description', () => {
    const sections = [
      {
        title: 'Appearance',
        rows: [
          { id: 'theme', title: 'Theme', description: 'Light or dark', control: { kind: 'select' as const, value: 'Light', options: ['Light'] } },
          { id: 'proxy', title: 'Proxy', description: 'HTTP and SOCKS5', control: { kind: 'static' as const, text: '' } },
        ],
      },
    ];
    expect(filterRows(sections, 'theme')[0].rows.map((r) => r.id)).toEqual(['theme']);
    expect(filterRows(sections, 'socks')[0].rows.map((r) => r.id)).toEqual(['proxy']);
    expect(filterRows(sections, 'zzz')).toHaveLength(0);
  });
});

describe('U05 provider form validation', () => {
  it('flags missing name and models', () => {
    expect(validateProviderForm({ name: '', modelLine: '' })).toEqual(['name', 'model']);
    expect(validateProviderForm({ name: 'OJ', modelLine: '' })).toEqual(['model']);
    expect(validateProviderForm({ name: 'OJ', modelLine: 'A = a' })).toEqual([]);
  });
});

describe('U05 demo settings actions', () => {
  beforeEach(() => useDemoStore.getState().reset());

  it('theme, language and font size rows update the preview store', () => {
    const { rowControl } = useDemoStore.getState();
    rowControl('theme', 'Dark');
    expect(useDemoStore.getState().theme).toBe('dark');
    rowControl('theme', 'Light');
    expect(useDemoStore.getState().theme).toBe('light');
    rowControl('language', '中文');
    expect(useDemoStore.getState().lang).toBe('zh');
    rowControl('fontsize', 110);
    expect(useDemoStore.getState().fontScale).toBe(110);
    rowControl('proxy', 'Direct');
    expect(useDemoStore.getState().proxy).toBe('Direct');
  });

  it('provider add validates, then appends a demo provider', () => {
    const store = useDemoStore.getState();
    store.setProviderForm({ open: true, name: '', modelLine: '' });
    store.addProvider();
    expect(useDemoStore.getState().providerForm.error).toBe('name');
    useDemoStore.getState().setProviderForm({ name: 'Test GW', modelLine: 'A = a' });
    useDemoStore.getState().addProvider();
    const state = useDemoStore.getState();
    expect(state.providers.find((p) => p.name === 'Test GW')?.modelCount).toBe(1);
    expect(state.providerForm.open).toBe(false);
  });

  it('provider toggle / delete / makeDefault work on demo data', () => {
    const store = useDemoStore.getState();
    store.toggleProvider('prov-oj');
    expect(useDemoStore.getState().providers[0].enabled).toBe(false);
    store.makeDefault('prov-oj');
    expect(useDemoStore.getState().defaultModelLabel).toBe('OJ Gateway');
    store.deleteProvider('prov-oj');
    expect(useDemoStore.getState().providers).toHaveLength(0);
  });
});
