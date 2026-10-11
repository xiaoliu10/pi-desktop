import { describe, expect, it } from 'vitest';
import { guessExtensionFor, mergeRuntimeProviders, runtimeModelsFromRuns } from '../src/main/pi/provider-registry';
import type { PiModel, PiModelCatalog } from '../src/shared/pi';

const model = (id: string, provider: string, name = id): PiModel => ({ id, name, provider });
const emptyCatalog = (): PiModelCatalog => ({ providers: [], defaultProvider: undefined, defaultModel: undefined });

describe('guessExtensionFor', () => {
  it.each([
    ['antigravity', ['npm:pi-antigravity'], 'pi-antigravity'],
    ['antigravity', ['npm:pi-antigravity@^1.0', 'npm:pi-memory'], 'pi-antigravity'],
    ['antigravity', ['npm:pi-memory'], undefined],
    ['antigravity', ['npm:pi-antigravity-extra'], 'pi-antigravity-extra'],
    ['antigravity', [], undefined],
  ])('guessExtensionFor(%j, %j) = %j', (id, pkgs, expected) => {
    expect(guessExtensionFor(id, pkgs)).toBe(expected);
  });
});

describe('mergeRuntimeProviders', () => {
  it('registers extension providers that only exist at runtime', () => {
    const catalog = mergeRuntimeProviders(emptyCatalog(), [
      model('gemini-3.8-flash', 'antigravity'), model('gemini-3.7-flash', 'antigravity'), model('claude-x', 'acme'),
    ], ['npm:pi-antigravity']);
    expect(catalog.providers.map(p => p.id).sort()).toEqual(['acme', 'antigravity']);
    const ag = catalog.providers.find(p => p.id === 'antigravity')!;
    expect(ag.source).toBe('runtime');
    expect(ag.originExtension).toBe('pi-antigravity');
    expect(ag.models.map(m => m.id)).toEqual(['gemini-3.8-flash', 'gemini-3.7-flash']);
    expect(ag.models[0]).toMatchObject({ definition: 'builtin', name: 'gemini-3.8-flash' });
    const acme = catalog.providers.find(p => p.id === 'acme')!;
    expect(acme.originExtension).toBeUndefined();
  });

  it('fills missing models into existing providers without overwriting catalog metadata', () => {
    const catalog = emptyCatalog();
    catalog.providers.push({
      id: 'antigravity', name: 'Antigravity', source: 'models-store.json', auth: 'oauth', originExtension: 'pi-antigravity',
      models: [{ definition: 'builtin', id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', contextWindow: 1048576 }],
    });
    mergeRuntimeProviders(catalog, [model('gemini-3.8-flash', 'antigravity'), model('gemini-new', 'antigravity')], ['npm:pi-antigravity']);
    const ag = catalog.providers[0];
    expect(ag.models).toHaveLength(2);
    // 已有条目的元数据不被 runtime 空壳覆盖
    expect(ag.models[0]).toMatchObject({ name: 'Gemini 3.8 Flash', contextWindow: 1048576 });
    expect(ag.models[1].id).toBe('gemini-new');
    expect(ag.originExtension).toBe('pi-antigravity');
  });

  it('ignores empty runtime input and models without provider', () => {
    const catalog = emptyCatalog();
    expect(mergeRuntimeProviders(catalog, undefined)).toBe(catalog);
    expect(mergeRuntimeProviders(catalog, []).providers).toEqual([]);
    mergeRuntimeProviders(catalog, [{ id: 'x', name: 'x', provider: '' } as PiModel]);
    expect(catalog.providers).toEqual([]);
  });

  it('prefers a running snapshot over idle ones', () => {
    const runs = [
      { status: 'idle', models: [model('old', 'prov-a')] },
      { status: 'running', models: [model('fresh', 'prov-b')] },
    ];
    const catalog = mergeRuntimeProviders(emptyCatalog(), runtimeModelsFromRuns(runs));
    expect(catalog.providers.map(p => p.id)).toEqual(['prov-b']);
  });

  it('returns the catalog untouched when no run has models', () => {
    const catalog = emptyCatalog();
    expect(runtimeModelsFromRuns([{ status: 'running', models: [] }])).toBeUndefined();
    expect(mergeRuntimeProviders(catalog, runtimeModelsFromRuns([{ status: 'running', models: [] }]))).toBe(catalog);
  });
});
