import { beforeEach, describe, expect, it } from 'vitest';
import { filterInstalled, filterMarketplace, groupByStatus, uniqueTags } from '../replica/plugins/helpers';
import { demoInstalledPlugins, demoMarketplaceCards } from './fixtures';
import { useDemoStore } from './adapter';

describe('U04 plugin filtering & grouping', () => {
  it('searches installed rows by name and package id', () => {
    const rows = demoInstalledPlugins('en');
    expect(filterInstalled(rows, 'git').map((r) => r.id)).toEqual(['pl-git']);
    expect(filterInstalled(rows, 'pi.deploy')).toHaveLength(1);
    expect(filterInstalled(rows, '')).toHaveLength(rows.length);
  });

  it('groups rows in reference status order', () => {
    const groups = groupByStatus(demoInstalledPlugins('en'));
    expect(groups.map((g) => g.status)).toEqual(['attention', 'updatable', 'active', 'off']);
    expect(groups.find((g) => g.status === 'attention')?.items[0].error).toBeTruthy();
  });

  it('filters marketplace by tag and query', () => {
    const cards = demoMarketplaceCards('en');
    expect(filterMarketplace(cards, '', 'data').map((c) => c.id)).toEqual(['mp-sql']);
    expect(filterMarketplace(cards, 'git', 'all')).toHaveLength(1);
    expect(filterMarketplace(cards, 'zzz', 'all')).toHaveLength(0);
    expect(uniqueTags(cards)).toEqual(['data', 'editing', 'productivity']);
  });
});

describe('U04 demo plugin state transitions', () => {
  beforeEach(() => {
    useDemoStore.getState().reset();
    useDemoStore.setState({ plugins: demoInstalledPlugins('en') });
  });

  it('toggles a plugin between active and off', () => {
    const { togglePlugin } = useDemoStore.getState();
    togglePlugin('pl-markdown');
    expect(useDemoStore.getState().plugins.find((p) => p.id === 'pl-markdown')?.status).toBe('off');
    togglePlugin('pl-markdown');
    expect(useDemoStore.getState().plugins.find((p) => p.id === 'pl-markdown')?.status).toBe('active');
  });

  it('update moves an updatable plugin to the latest version', () => {
    const { updatePlugin } = useDemoStore.getState();
    updatePlugin('pl-git');
    const git = useDemoStore.getState().plugins.find((p) => p.id === 'pl-git');
    expect(git?.version).toBe('1.5.0');
    expect(git?.status).toBe('active');
  });

  it('marketplace install adds a demo row and marks the card installed', () => {
    const { installPlugin } = useDemoStore.getState();
    installPlugin('mp-sql');
    const state = useDemoStore.getState();
    expect(state.plugins.find((p) => p.packageId === 'pi.sql')).toBeTruthy();
    expect(state.marketplace.find((m) => m.id === 'mp-sql')?.installedVersion).toBe('2.1.0');
  });

  it('applyUpdates clears the update banner', () => {
    const { applyUpdates } = useDemoStore.getState();
    expect(useDemoStore.getState().pluginUpdatesReady).toBe(1);
    applyUpdates();
    expect(useDemoStore.getState().pluginUpdatesReady).toBe(0);
    expect(useDemoStore.getState().plugins.every((p) => p.status !== 'updatable')).toBe(true);
  });
});
