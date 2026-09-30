import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { isDefaultModel } from '../src/renderer/replica/settings/helpers';
import { SettingsPage } from '../src/renderer/replica/settings/SettingsPage';
import { replicaLabels } from '../src/renderer/replica/i18n';
import { usePiStore } from '../src/renderer/pi/adapter';
import type { SettingsProps } from '../src/renderer/replica/contracts';
import type { PiModelCatalog } from '../src/shared/pi';

const defaults = { defaultProvider: 'alpha', defaultModel: 'shared/id' };
const catalog: PiModelCatalog = { ...defaults, providers: [] };
const noop = () => {};
const props: SettingsProps = {
  page: 'models', query: '', theme: 'light', sections: [],
  providers: [{ id: 'alpha', name: 'Provider', baseUrl: '', modelCount: 2, isDefault: true, enabled: true, source: 'models.json', auth: 'api_key', models: [{ id: 'shared/id', name: 'Same display name' }, { id: 'other', name: 'Same display name' }] }],
  providerForm: { open: false, editingId: null, name: '', baseUrl: '', apiKey: '', modelLine: '' },
  ...defaults, defaultModelLabel: 'shared/id · alpha', vendorEmpty: '', catalogInfo: '', demo: false,
  labels: replicaLabels('zh').settings, onBack: noop, onSearch: noop, onSelectPage: noop, onRowControl: noop,
  onSetProviderForm: noop, onSaveProvider: noop, onEditProvider: noop, onDeleteProvider: noop,
  onToggleProvider: noop, onMakeDefault: noop, onRefreshCatalog: noop, onSelectDefaultModel: noop,
};

afterEach(() => vi.unstubAllGlobals());

describe('persisted model identity and real settings rows', () => {
  it('requires both raw IDs, not a display name, provider flag, or concatenated path', () => {
    expect(isDefaultModel(defaults, 'alpha', 'shared/id')).toBe(true);
    expect(isDefaultModel(defaults, 'beta', 'shared/id')).toBe(false);
    expect(isDefaultModel(defaults, 'alpha', 'Same display name')).toBe(false);
    expect(isDefaultModel({ defaultProvider: 'alpha/shared', defaultModel: 'id' }, 'alpha', 'shared/id')).toBe(false);
    expect(isDefaultModel({ defaultProvider: 'alpha' }, 'alpha', '')).toBe(false);
    expect(isDefaultModel({ defaultModel: 'shared/id' }, '', 'shared/id')).toBe(false);
    expect(isDefaultModel({}, 'alpha', 'shared/id')).toBe(false);
  });
  it.each(['zh', 'en'] as const)('renders one localized badge and disabled current-default action (%s)', lang => {
    const labels = replicaLabels(lang).settings;
    const html = renderToStaticMarkup(createElement(SettingsPage, { ...props, labels }));
    expect(html.match(/class="pi-model-default-badge"/g)).toHaveLength(1);
    expect(html).toContain(`class="pi-model-default-badge">${labels.defaultBadge}</span>`);
    expect(html).toContain(`disabled="" aria-label="${labels.alreadyDefault} · alpha / shared/id"`);
    expect(html).toContain(`aria-label="${labels.makeDefault} · alpha / other"`);
  });
  it('moves the marker within a provider despite identical display names', () => {
    const html = renderToStaticMarkup(createElement(SettingsPage, { ...props, defaultModel: 'other' }));
    expect(html).toContain('disabled="" aria-label="已设为默认 · alpha / other"');
    expect(html).not.toContain('disabled="" aria-label="已设为默认 · alpha / shared/id"');
  });
  it('does not mark duplicate IDs in a different provider or trust the provider badge', () => {
    const html = renderToStaticMarkup(createElement(SettingsPage, { ...props, defaultProvider: 'beta' }));
    expect(html).not.toContain('class="pi-model-default-badge"');
    expect(html).not.toContain('已设为默认');
  });
  it('does not infer defaults from the summary label when catalog identity is absent', () => {
    const html = renderToStaticMarkup(createElement(SettingsPage, { ...props, defaultProvider: undefined, defaultModel: undefined }));
    expect(html).not.toContain('class="pi-model-default-badge"');
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('catalog refresh after saving defaults', () => {
  it('reloads persisted defaults without changing the marker while pending', async () => {
    const request = deferred<PiModelCatalog>();
    vi.stubGlobal('window', { localPi: { modelCatalog: () => request.promise } });
    usePiStore.setState({ catalog, catalogLoading: false });
    const done = usePiStore.getState().loadCatalog();
    expect(usePiStore.getState().catalog).toBe(catalog);
    request.resolve({ ...catalog, defaultModel: 'other' });
    await done;
    expect(usePiStore.getState().catalog?.defaultModel).toBe('other');
    expect(usePiStore.getState().catalogLoading).toBe(false);
  });
  it.each(['success', 'failure'] as const)('a stale pre-save %s cannot overwrite a newer post-save read', async outcome => {
    const old = deferred<PiModelCatalog>(), fresh = deferred<PiModelCatalog>();
    const modelCatalog = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    vi.stubGlobal('window', { localPi: { modelCatalog } });
    usePiStore.setState({ catalog, catalogLoading: false, error: undefined });
    const first = usePiStore.getState().loadCatalog();
    const second = usePiStore.getState().loadCatalog();
    expect(modelCatalog).toHaveBeenCalledTimes(2);
    fresh.resolve({ ...catalog, defaultProvider: 'beta' });
    await second;
    if (outcome === 'success') old.resolve(catalog); else old.reject(Error('stale failure'));
    await first;
    expect(usePiStore.getState().catalog?.defaultProvider).toBe('beta');
    expect(usePiStore.getState().error).toBeUndefined();
    expect(usePiStore.getState().catalogLoading).toBe(false);
  });
  it('does not let stale completion end a pending refresh', async () => {
    const old = deferred<PiModelCatalog>(), fresh = deferred<PiModelCatalog>();
    vi.stubGlobal('window', { localPi: { modelCatalog: vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise) } });
    usePiStore.setState({ catalog, catalogLoading: false });
    const first = usePiStore.getState().loadCatalog(), second = usePiStore.getState().loadCatalog();
    old.resolve(catalog); await first;
    expect(usePiStore.getState().catalogLoading).toBe(true);
    fresh.resolve({ ...catalog, defaultModel: 'other' }); await second;
    expect(usePiStore.getState().catalogLoading).toBe(false);
  });
  it('retains the last persisted marker on reload failure', async () => {
    vi.stubGlobal('window', { localPi: { modelCatalog: vi.fn().mockRejectedValue(Error('mock read failure')) } });
    usePiStore.setState({ catalog, catalogLoading: false, error: undefined });
    await usePiStore.getState().loadCatalog();
    expect(usePiStore.getState().catalog).toBe(catalog);
    expect(usePiStore.getState().error).toBe('mock read failure');
    expect(usePiStore.getState().catalogLoading).toBe(false);
  });
});
