import { describe, expect, it } from 'vitest';
import { guessExtensionFor, mergeRuntimeProviders, packagesFromSettings, runtimeModelsFromRuns } from '../src/main/pi/provider-registry';
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

  it('unions models across runs (project-level extensions make snapshots differ)', () => {
    const runs = [
      { status: 'idle', models: [model('only-a', 'prov-a'), model('shared', 'prov-a')] },
      { status: 'running', models: [model('shared', 'prov-a'), model('only-b', 'prov-b')] },
    ];
    const catalog = mergeRuntimeProviders(emptyCatalog(), runtimeModelsFromRuns(runs));
    const a = catalog.providers.find(p => p.id === 'prov-a')!;
    const b = catalog.providers.find(p => p.id === 'prov-b')!;
    expect(a.models.map(m => m.id)).toEqual(['only-a', 'shared']);
    expect(b.models.map(m => m.id)).toEqual(['only-b']);
  });

  it('deduplicates identical models repeated across snapshots', () => {
    const catalog = mergeRuntimeProviders(emptyCatalog(), [model('dup', 'prov'), model('dup', 'prov')]);
    expect(catalog.providers[0].models).toHaveLength(1);
  });

  it('returns the catalog untouched when no run has models', () => {
    const catalog = emptyCatalog();
    expect(runtimeModelsFromRuns([{ status: 'running', models: [] }])).toBeUndefined();
    expect(mergeRuntimeProviders(catalog, runtimeModelsFromRuns([{ status: 'running', models: [] }]))).toBe(catalog);
  });
});

describe('packagesFromSettings', () => {
  it('accepts both string and {source} forms', () => {
    expect(packagesFromSettings({ packages: ['npm:pi-antigravity', { source: 'npm:pi-memory' }, { other: 1 }, 42] })).toEqual(['npm:pi-antigravity', 'npm:pi-memory']);
    expect(packagesFromSettings(undefined)).toEqual([]);
    expect(packagesFromSettings({ packages: 'not-array' })).toEqual([]);
  });

  it('guesses extension from object-form package entries', () => {
    expect(guessExtensionFor('antigravity', packagesFromSettings({ packages: [{ source: 'npm:pi-antigravity' }] }))).toBe('pi-antigravity');
  });

  it('prefers exact pi-<id> over looser prefix matches', () => {
    expect(guessExtensionFor('antigravity', ['pi-antigravity-extra', 'pi-antigravity'])).toBe('pi-antigravity');
    expect(guessExtensionFor('antigravity-extra', ['pi-antigravity', 'pi-antigravity-extra'])).toBe('pi-antigravity-extra');
  });
});
