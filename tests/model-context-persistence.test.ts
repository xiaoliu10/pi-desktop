import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { PiAccounts } from '../src/main/pi/accounts';
import type { PiCatalogModel, PiModelEditableField } from '../src/shared/pi';
import { mergeModelCatalog, readModelCatalog, writeModelProvider } from '../src/main/pi/model-catalog';

const dirs: string[] = [];
function fixture(overrides = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-context-')); dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'auth.json'), '{}');
  fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify({ providers: {
    alpha: { baseUrl: 'https://example.invalid/v1', api: 'openai-completions', apiKey: 'synthetic-only', headers: { 'x-fixture': 'keep' },
      models: [{ id: 'shared', contextWindow: 1000000, maxTokens: 32000, unknown: { keep: true } }],
      ...(overrides ? { modelOverrides: { shared: { contextWindow: 1000000, compat: { supportsStore: false } } } } : {}) },
    beta: { baseUrl: 'https://example.invalid/v1', api: 'openai-completions', models: [{ id: 'shared', contextWindow: 1000000 }] },
  } }));
  return dir;
}
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const load = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'models.json'), 'utf8'));
const runtimeUrl = pathToFileURL(path.resolve('resources/pi-runtime/node_modules/@earendil-works/pi-coding-agent/dist/core/model-runtime.js')).href;
async function runtimeFor(dir: string) {
  const { ModelRuntime } = await import(/* @vite-ignore */ runtimeUrl);
  return ModelRuntime.create({ modelsPath: path.join(dir, 'models.json'), authPath: path.join(dir, 'auth.json'), allowModelNetwork: false });
}
function patch(dir: string, model: PiCatalogModel, fields: PiModelEditableField[], provider = 'alpha', kind: 'custom' | 'override' = 'custom') {
  return writeModelProvider(dir, { id: provider, baseUrl: '', models: [model], modelEdit: { originalId: model.id, kind, fields } });
}

it('an omitted context in a later partial edit cannot erase the saved limit', () => {
  const dir = fixture();
  writeModelProvider(dir, { id: 'alpha', baseUrl: 'https://example.invalid/v1', models: [{ id: 'shared', contextWindow: 200000 }] });
  writeModelProvider(dir, { id: 'alpha', baseUrl: 'https://example.invalid/v1', models: [{ id: 'shared', name: 'Renamed' }] });
  expect(readModelCatalog(dir).providers[0].models[0].contextWindow).toBe(200000);
  expect(load(dir).providers.alpha.models[0].maxTokens).toBe(32000);
});

it('a saved context must update an existing higher-priority model override too', async () => {
  const dir = fixture(true);
  writeModelProvider(dir, { id: 'alpha', baseUrl: 'https://example.invalid/v1', models: [{ id: 'shared', contextWindow: 200000, maxTokens: 32000 }] });
  // Load the actual pinned runtime, not a copied merge algorithm. No credentials/network.
  const moduleUrl = pathToFileURL(path.resolve('resources/pi-runtime/node_modules/@earendil-works/pi-coding-agent/dist/core/model-runtime.js')).href;
  const { ModelRuntime } = await import(/* @vite-ignore */ moduleUrl);
  const runtime = await ModelRuntime.create({ modelsPath: path.join(dir, 'models.json'), authPath: path.join(dir, 'auth.json'), allowModelNetwork: false });
  expect(runtime.getError()).toBeUndefined();
  expect(runtime.getModel('alpha', 'shared').contextWindow).toBe(200000);
  expect(runtime.getModel('beta', 'shared').contextWindow).toBe(1000000);
});

it('patches latest disk values only, preserving external edits, added models and secrets', () => {
  const dir = fixture(true), file = path.join(dir, 'models.json');
  const stale = readModelCatalog(dir).providers[0].models[0];
  const external = load(dir);
  Object.assign(external.providers.alpha, { name: 'external', apiKey: 'rotated-fixture', baseUrl: 'https://new.invalid/v1', extra: 123 });
  Object.assign(external.providers.alpha.models[0], { name: 'external model', maxTokens: 48000, headers: { keep: 'model-header' } });
  external.providers.alpha.models.push({ id: 'external-model', contextWindow: 64000 });
  fs.writeFileSync(file, JSON.stringify(external));
  patch(dir, { ...stale, contextWindow: 200000 }, ['contextWindow']);
  const saved = load(dir);
  expect(saved.providers.alpha).toMatchObject({ name: 'external', apiKey: 'rotated-fixture', baseUrl: 'https://new.invalid/v1', headers: { 'x-fixture': 'keep' }, extra: 123 });
  expect(saved.providers.alpha.models).toEqual([{ ...external.providers.alpha.models[0], contextWindow: 200000 }, external.providers.alpha.models[1]]);
  expect(saved.providers.alpha.modelOverrides.shared).toEqual({ contextWindow: 200000, compat: { supportsStore: false } });
  expect(saved.providers.beta).toEqual(external.providers.beta);
  expect(JSON.stringify(readModelCatalog(dir))).not.toContain('rotated-fixture');
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
});

it('checks the merged output cap, including omitted fields and pi defaults, before any write', () => {
  const dir = fixture(), file = path.join(dir, 'models.json'), before = fs.readFileSync(file, 'utf8');
  expect(() => patch(dir, { id: 'shared', contextWindow: 16000 }, ['contextWindow'])).toThrow('最大输出');
  expect(() => writeModelProvider(dir, { id: 'alpha', baseUrl: 'https://example.invalid', models: [{ id: 'shared', contextWindow: 16000 }] })).toThrow('最大输出');
  expect(() => writeModelProvider(dir, { id: 'new', baseUrl: 'https://example.invalid', models: [{ id: 'new', contextWindow: 100 }] })).toThrow('最大输出');
  expect(fs.readFileSync(file, 'utf8')).toBe(before);
  patch(dir, { id: 'shared', contextWindow: 16000, maxTokens: 8000 }, ['contextWindow', 'maxTokens']);
  expect(load(dir).providers.alpha.models[0]).toMatchObject({ contextWindow: 16000, maxTokens: 8000 });
});

it('explicit clear restores defaults, whereas omitted/undefined fields preserve limits', () => {
  const dir = fixture();
  patch(dir, { id: 'shared', contextWindow: 200000 }, ['contextWindow']);
  patch(dir, { id: 'shared', contextWindow: undefined, name: 'new' }, ['name']);
  expect(readModelCatalog(dir).providers[0].models[0].contextWindow).toBe(200000);
  patch(dir, { id: 'shared' }, ['contextWindow']);
  expect(load(dir).providers.alpha.models[0]).not.toHaveProperty('contextWindow');
  expect(load(dir).providers.alpha.modelOverrides.shared).not.toHaveProperty('contextWindow');
});

it('refuses to replace unreadable/malformed configuration with an empty document', () => {
  const dir = fixture(), file = path.join(dir, 'models.json');
  fs.writeFileSync(file, '{malformed');
  expect(() => patch(dir, { id: 'shared', contextWindow: 200000 }, ['contextWindow'])).toThrow('安全读取');
  expect(fs.readFileSync(file, 'utf8')).toBe('{malformed');
});

it('custom extension refresh cannot defeat an explicit local override; old model objects stay old until reload', async () => {
  const dir = fixture();
  const file = path.join(dir, 'models.json'), doc = load(dir);
  doc.providers.alpha.models[0].contextWindow = 200000;
  fs.writeFileSync(file, JSON.stringify(doc));
  const runtime = await runtimeFor(dir);
  expect(runtime.getModel('alpha', 'shared').contextWindow).toBe(200000);
  const upstream = { ...runtime.getModel('alpha', 'shared'), contextWindow: 1000000 };
  runtime.registerProvider('alpha', { api: upstream.api, baseUrl: upstream.baseUrl, models: [upstream], refreshModels: async () => [{ ...upstream, contextWindow: 1000000 }] });
  await runtime.refresh({ allowNetwork: false, providers: ['alpha'] });
  const oldSessionModel = runtime.getModel('alpha', 'shared');
  expect(oldSessionModel.contextWindow).toBe(1000000); // extension replacement beats models[]
  expect(load(dir).providers.alpha.models[0].contextWindow).toBe(200000); // not a source-file rewrite
  patch(dir, { id: 'shared', contextWindow: 200000 }, ['contextWindow']);
  expect(oldSessionModel.contextWindow).toBe(1000000);
  await runtime.refresh({ allowNetwork: false, providers: ['alpha'] });
  expect(runtime.getError()).toBeUndefined();
  expect(runtime.getModel('alpha', 'shared').contextWindow).toBe(200000);
  expect(oldSessionModel.contextWindow).toBe(1000000);
  expect((await runtimeFor(dir)).getModel('alpha', 'shared').contextWindow).toBe(200000);
});

it('built-in models use modelOverrides, survive store refresh/restart, and keep sibling models', async () => {
  const dir = fixture(), file = path.join(dir, 'models.json');
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ openai: { type: 'api_key', key: 'synthetic-only' } }));
  const initial = await runtimeFor(dir), base = initial.getModels('openai')[0];
  const discovered = { ...base, contextWindow: 1000000, maxTokens: 32000 };
  const storeFile = path.join(dir, 'models-store.json');
  fs.writeFileSync(storeFile, JSON.stringify({ openai: { models: [discovered], lastModified: 9000000000000, checkedAt: Date.now() } }));
  const runtime = await runtimeFor(dir);
  expect(runtime.getModel('openai', base.id).contextWindow).toBe(1000000);
  patch(dir, { ...discovered, contextWindow: 200000 }, ['contextWindow'], 'openai', 'override');
  expect(load(dir).providers.openai).toEqual({ modelOverrides: { [base.id]: { contextWindow: 200000 } } });
  const saved = fs.readFileSync(file, 'utf8');
  for (const current of [runtime, await runtimeFor(dir)]) {
    await current.refresh({ allowNetwork: false, providers: ['openai'] });
    expect(current.getError()).toBeUndefined();
    expect(current.getModel('openai', base.id).contextWindow).toBe(200000);
    expect(current.getModels('openai').length).toBe(initial.getModels('openai').length);
  }
  // Exercise the real auto-refresh publish/store path, replacing fetch entirely.
  // This is synthetic remote metadata, NOT a request to pi.dev or the provider.
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify([discovered]), {
    status: 200, headers: { 'content-type': 'application/json', 'last-modified': 'Sun, 01 Jan 2090 00:00:00 GMT' },
  }));
  try {
    const result = await runtime.refresh({ allowNetwork: true, force: true, providers: ['openai'] });
    expect(result.errors.size).toBe(0);
    expect(fetchMock).toHaveBeenCalled();
    expect(runtime.getModel('openai', base.id).contextWindow).toBe(200000);
    expect(JSON.parse(fs.readFileSync(storeFile, 'utf8')).openai.models[0].contextWindow).toBe(1000000);
    expect((await runtimeFor(dir)).getModel('openai', base.id).contextWindow).toBe(200000);
  } finally { fetchMock.mockRestore(); }
  const accounts = new PiAccounts(() => dir);
  try {
    const native = await accounts.catalog();
    expect(native.find(p => p.id === 'openai')?.models.find(m => m.id === base.id)?.contextWindow).toBe(200000);
    const merged = mergeModelCatalog(readModelCatalog(dir), native);
    expect(merged.providers.find(p => p.id === 'openai')?.models.find(m => m.id === base.id)).toMatchObject({ definition: 'override', contextWindow: 200000 });
  } finally { accounts.dispose(); }
  expect(fs.readFileSync(file, 'utf8')).toBe(saved); // refresh writes the store, not user config
}, 30000);

it('catalog precedence is provider-scoped and never copies discovered defaults into local overrides', () => {
  const dir = fixture();
  patch(dir, { id: 'shared', contextWindow: 200000 }, ['contextWindow']);
  const native = ['alpha', 'beta'].map(id => ({ id, source: 'auth' as const, auth: 'api_key' as const, models: [{ id: 'shared', contextWindow: 1000000, maxTokens: 64000 }, { id: 'discovered', contextWindow: 1000000 }] }));
  const merged = mergeModelCatalog(readModelCatalog(dir), native);
  expect(merged.providers[0].models[0]).toMatchObject({ contextWindow: 200000, maxTokens: 32000, definition: 'custom' });
  expect(merged.providers[1].models[0].contextWindow).toBe(1000000);
  expect(merged.providers[0].models[1].definition).toBe('override');
  expect(load(dir).providers.alpha.modelOverrides.shared).toEqual({ contextWindow: 200000 });
});

it('a fresh actual CLI RPC session reports context 200k without sending a provider request', async () => {
  const dir = fixture();
  patch(dir, { id: 'shared', contextWindow: 200000 }, ['contextWindow']);
  const cli = path.resolve('resources/pi-runtime/node_modules/@earendil-works/pi-coding-agent/dist/cli.js');
  const child = spawn(process.execPath, [cli, '--mode', 'rpc', '--provider', 'alpha', '--model', 'shared', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-session', '--offline'], {
    cwd: dir, env: { PATH: process.env.PATH, HOME: dir, PI_CODING_AGENT_DIR: dir, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.resume();
  try {
    const state: any = await new Promise((resolve, reject) => {
      let buffer = '';
      const timeout = setTimeout(() => reject(Error('RPC get_state timed out')), 15000);
      child.once('error', e => { clearTimeout(timeout); reject(e); });
      child.once('exit', code => { clearTimeout(timeout); reject(Error(`RPC exited ${code}`)); });
      child.stdout.on('data', chunk => {
        buffer += chunk;
        const lines = buffer.split('\n'); buffer = lines.pop()!;
        for (const line of lines) { try { const msg = JSON.parse(line); if (msg.id === 'context-test') { clearTimeout(timeout); resolve(msg); } } catch {} }
      });
      child.stdin.write(JSON.stringify({ id: 'context-test', type: 'get_state' }) + '\n');
    });
    expect(state.success).toBe(true);
    expect(state.data.model).toMatchObject({ provider: 'alpha', id: 'shared', contextWindow: 200000, maxTokens: 32000 });
  } finally {
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill(); await exited;
  }
}, 20000);

