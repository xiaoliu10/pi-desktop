import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readModelCatalog, writeDefaultModel, writeModelProvider, removeModelProvider } from '../src/main/pi/model-catalog';

function makeAgentDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-catalog-'));
  fs.writeFileSync(
    path.join(dir, 'settings.json'),
    JSON.stringify({ theme: 'light', defaultProvider: 'openai-codex', defaultModel: 'gpt-5.4-mini' }),
  );
  fs.writeFileSync(
    path.join(dir, 'models.json'),
    JSON.stringify({
      providers: {
        'qwen38-gpu': {
          name: 'GPU-vllm',
          baseUrl: 'http://10.0.0.8:4000/v1',
          api: 'openai-completions',
          apiKey: 'sk-secret-do-not-leak',
          models: [{ id: 'Qwen3.8-27B', name: 'Qwen 27B', contextWindow: 172800, maxTokens: 131072, reasoning: true }],
        },
      },
    }),
  );
  fs.writeFileSync(
    path.join(dir, 'auth.json'),
    JSON.stringify({
      'openai-codex': { type: 'oauth', access: 'tok', refresh: 'tok2', expires: 1 },
      deepseek: { type: 'api_key', key: 'sk-also-secret' },
    }),
  );
  return dir;
}

describe('P08 model catalog (read-only pi config)', () => {
  it('merges models.json + auth.json and reports the default model', () => {
    const catalog = readModelCatalog(makeAgentDir());
    expect(catalog.defaultModel).toBe('gpt-5.4-mini');
    expect(catalog.defaultProvider).toBe('openai-codex');
    expect(catalog.providers.map((p) => p.id)).toEqual(['qwen38-gpu', 'openai-codex', 'deepseek']);
    const qwen = catalog.providers[0];
    expect(qwen.source).toBe('models.json');
    expect(qwen.baseUrl).toBe('http://10.0.0.8:4000/v1');
    expect(qwen.auth).toBe('api_key');
    expect(qwen.models[0]).toMatchObject({ id: 'Qwen3.8-27B', contextWindow: 172800, reasoning: true });
  });

  it('never exposes secrets', () => {
    const dir = makeAgentDir();
    const catalog = readModelCatalog(dir);
    const text = JSON.stringify(catalog);
    expect(text).not.toContain('sk-secret-do-not-leak');
    expect(text).not.toContain('sk-also-secret');
    expect(text).not.toContain('tok');
    expect(catalog.providers.find((p) => p.id === 'deepseek')?.auth).toBe('api_key');
    expect(catalog.providers.find((p) => p.id === 'openai-codex')?.auth).toBe('oauth');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('tolerates missing files', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-catalog-empty-'));
    const catalog = readModelCatalog(empty);
    expect(catalog.providers).toEqual([]);
    expect(catalog.defaultModel).toBeUndefined();
    fs.rmSync(empty, { recursive: true, force: true });
  });
});

describe('P08 model catalog writes (shared pi config)', () => {
  it('writes the default model into settings.json preserving other fields', () => {
    const dir = makeAgentDir();
    const catalog = writeDefaultModel(dir, { provider: 'qwen38-gpu', model: 'Qwen3.8-27B' });
    expect(catalog.defaultProvider).toBe('qwen38-gpu');
    expect(catalog.defaultModel).toBe('Qwen3.8-27B');
    const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    expect(settings.theme).toBe('light'); // untouched field survives
    // clearing works too
    const cleared = writeDefaultModel(dir, {});
    expect(cleared.defaultProvider).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).theme).toBe('light');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates and updates providers, preserving the stored key when omitted', () => {
    const dir = makeAgentDir();
    const catalog = writeModelProvider(dir, {
      id: 'new-relay', name: 'New Relay', baseUrl: 'https://relay.example.com/v1', api: 'openai-completions',
      apiKey: 'sk-new-key', models: [{ id: 'm1', name: 'Model One', contextWindow: 64000, reasoning: true }, { id: 'm2' }],
    });
    expect(catalog.providers.find((p) => p.id === 'new-relay')?.models).toHaveLength(2);
    const stored = JSON.parse(fs.readFileSync(path.join(dir, 'models.json'), 'utf8'));
    expect(stored.providers['new-relay'].apiKey).toBe('sk-new-key');
    // update without a key keeps the old one
    writeModelProvider(dir, { id: 'new-relay', baseUrl: 'https://relay.example.com/v2', models: [{ id: 'm1' }] });
    const updated = JSON.parse(fs.readFileSync(path.join(dir, 'models.json'), 'utf8'));
    expect(updated.providers['new-relay'].apiKey).toBe('sk-new-key');
    expect(updated.providers['new-relay'].baseUrl).toBe('https://relay.example.com/v2');
    expect(fs.statSync(path.join(dir, 'models.json')).mode & 0o777).toBe(0o600);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects invalid provider drafts without touching the file', () => {
    const dir = makeAgentDir();
    const before = fs.readFileSync(path.join(dir, 'models.json'), 'utf8');
    expect(() => writeModelProvider(dir, { id: 'bad id!', baseUrl: 'https://x/v1', models: [{ id: 'm' }] })).toThrow('ID');
    expect(() => writeModelProvider(dir, { id: 'ok', baseUrl: 'ftp://x', models: [{ id: 'm' }] })).toThrow('Base URL');
    expect(() => writeModelProvider(dir, { id: 'ok', baseUrl: 'https://x/v1', models: [] })).toThrow('模型');
    expect(fs.readFileSync(path.join(dir, 'models.json'), 'utf8')).toBe(before);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('removes only models.json providers and leaves auth entries alone', () => {
    const dir = makeAgentDir();
    const catalog = removeModelProvider(dir, 'qwen38-gpu');
    expect(catalog.providers.find((p) => p.id === 'qwen38-gpu')).toBeUndefined();
    expect(catalog.providers.find((p) => p.id === 'openai-codex')?.auth).toBe('oauth');
    expect(() => removeModelProvider(dir, 'openai-codex')).not.toThrow(); // auth entry untouched
    expect(catalog.providers.find((p) => p.id === 'openai-codex')).toBeDefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

it('round trips model capabilities and preserves advanced fields during editing', () => {
  const dir = makeAgentDir();
  try {
    const file = path.join(dir, 'models.json');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    Object.assign(doc.providers['qwen38-gpu'].models[0], { input:['text','image'], compat:{supportsStore:false}, cost:{input:2,output:3,cacheRead:0,cacheWrite:0} });
    fs.writeFileSync(file,JSON.stringify(doc));
    const provider=readModelCatalog(dir).providers[0];
    expect(provider.models[0].input).toEqual(['text','image']);
    writeModelProvider(dir,{...provider,baseUrl:provider.baseUrl!,models:provider.models.map(m=>({...m,contextWindow:200000,maxTokens:50000,reasoning:false,input:['text']}))});
    const saved=JSON.parse(fs.readFileSync(file,'utf8')).providers['qwen38-gpu'];
    expect(saved.models[0]).toMatchObject({contextWindow:200000,maxTokens:50000,reasoning:false,input:['text'],compat:{supportsStore:false},cost:{input:2}});
    expect(saved.apiKey).toBe('sk-secret-do-not-leak');
    expect(readModelCatalog(dir).providers[0].models[0].maxTokens).toBe(50000);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

it('rejects invalid token limits and duplicate models atomically',()=>{
  const dir=makeAgentDir();
  try {
    const file=path.join(dir,'models.json'), before=fs.readFileSync(file,'utf8');
    for(const models of [[{id:'m',contextWindow:-1}],[{id:'m',maxTokens:1.5}],[{id:'m',contextWindow:100,maxTokens:101}],[{id:'m'},{id:'m'}],[{id:'m',input:['video']}]]) {
      expect(()=>writeModelProvider(dir,{id:'test',baseUrl:'https://example.com',models})).toThrow();
      expect(fs.readFileSync(file,'utf8')).toBe(before);
    }
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

it('persists thinking maps and clears them when restoring pi defaults',()=>{
  const dir=makeAgentDir();
  try {
    const provider=readModelCatalog(dir).providers[0];
    const model={...provider.models[0],thinkingLevelMap:{high:'high',xhigh:null,max:'max'}};
    const draft={...provider,baseUrl:provider.baseUrl!,models:[model]};
    writeModelProvider(dir,draft);
    expect(readModelCatalog(dir).providers[0].models[0].thinkingLevelMap).toEqual(model.thinkingLevelMap);
    const file=path.join(dir,'models.json'),before=fs.readFileSync(file,'utf8');
    expect(()=>writeModelProvider(dir,{...draft,models:[{...model,thinkingLevelMap:{high:true} as never}]})).toThrow('映射');
    expect(fs.readFileSync(file,'utf8')).toBe(before);
    writeModelProvider(dir,{...draft,models:[{...model,thinkingLevelMap:undefined}]});
    expect(JSON.parse(fs.readFileSync(file,'utf8')).providers[provider.id].models[0]).not.toHaveProperty('thinkingLevelMap');
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
