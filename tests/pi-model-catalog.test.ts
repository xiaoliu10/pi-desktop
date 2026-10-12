import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readModelCatalog, writeDefaultModel, writeModelProvider, removeModelProvider, writeProviderApiKey } from '../src/main/pi/model-catalog';

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

  it('deletes a single model via modelEdit and refuses the last remaining one', () => {
    const dir = makeAgentDir();
    writeModelProvider(dir, { id: 'del-relay', baseUrl: 'https://relay.example.com/v1', models: [{ id: 'm1', contextWindow: 128000 }, { id: 'm2' }] });
    const after = writeModelProvider(dir, { id: 'del-relay', baseUrl: '', models: [{ id: 'm1' }], modelEdit: { originalId: 'm1', kind: 'delete' } });
    expect(after.providers.find(p => p.id === 'del-relay')?.models.map(m => m.id)).toEqual(['m2']);
    // 删除不存在的模型 → 提示刷新而非静默
    expect(() => writeModelProvider(dir, { id: 'del-relay', baseUrl: '', models: [{ id: 'gone' }], modelEdit: { originalId: 'gone', kind: 'delete' } })).toThrow('已被移除');
    // 供应商至少保留一个模型
    expect(() => writeModelProvider(dir, { id: 'del-relay', baseUrl: '', models: [{ id: 'm2' }], modelEdit: { originalId: 'm2', kind: 'delete' } })).toThrow('至少需要一个模型');
    // 删除后 models.json 与目录保持一致
    const stored = JSON.parse(fs.readFileSync(path.join(dir, 'models.json'), 'utf8'));
    expect(stored.providers['del-relay'].models.map((m: { id: string }) => m.id)).toEqual(['m2']);
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

it('persists per-level sampling params and clears them when removed',()=>{
  const dir=makeAgentDir();
  try {
    const provider=readModelCatalog(dir).providers[0];
    const model={...provider.models[0],samplingParamsByThinkingLevel:{high:{temperature:0.7},max:{temperature:1,top_p:0.95}}};
    const draft={...provider,baseUrl:provider.baseUrl!,models:[model]};
    writeModelProvider(dir,draft);
    expect(readModelCatalog(dir).providers[0].models[0].samplingParamsByThinkingLevel).toEqual(model.samplingParamsByThinkingLevel);
    // modelEdit 链路同样可达（editableFields 含 samplingParamsByThinkingLevel）
    writeModelProvider(dir,{id:provider.id,baseUrl:provider.baseUrl!,models:[{...model,samplingParamsByThinkingLevel:{high:{temperature:0.9}}}],modelEdit:{originalId:model.id,kind:'custom',fields:['samplingParamsByThinkingLevel']}});
    expect(readModelCatalog(dir).providers[0].models[0].samplingParamsByThinkingLevel).toEqual({high:{temperature:0.9}});
    const file=path.join(dir,'models.json'),before=fs.readFileSync(file,'utf8');
    expect(()=>writeModelProvider(dir,{...draft,models:[{...model,samplingParamsByThinkingLevel:{high:'oops'} as never}]})).toThrow('参数映射');
    expect(fs.readFileSync(file,'utf8')).toBe(before);
    writeModelProvider(dir,{...draft,models:[{...model,samplingParamsByThinkingLevel:undefined}]});
    expect(JSON.parse(fs.readFileSync(file,'utf8')).providers[provider.id].models[0]).not.toHaveProperty('samplingParamsByThinkingLevel');
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

describe('P08 provider API key (auth.json, shared with pi CLI)', () => {
  it('sets an api_key for a provider without one, preserving other credentials, mode 0600', () => {
    const dir = makeAgentDir();
    const before = fs.readFileSync(path.join(dir, 'auth.json'), 'utf8');
    const catalog = writeProviderApiKey(dir, { id: 'zai-coding-cn', apiKey: '  sk-zai-new  ' });
    expect(catalog.providers.find((p) => p.id === 'zai-coding-cn')?.auth).toBe('api_key');
    const doc = JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8'));
    expect(doc['zai-coding-cn']).toEqual({ type: 'api_key', key: 'sk-zai-new' });
    expect(doc['openai-codex']).toEqual({ type: 'oauth', access: 'tok', refresh: 'tok2', expires: 1 });
    expect(doc.deepseek).toEqual({ type: 'api_key', key: 'sk-also-secret' });
    expect((fs.statSync(path.join(dir, 'auth.json')).mode & 0o777)).toBe(0o600);
    expect(JSON.stringify(catalog)).not.toContain('sk-zai-new');
    expect(before).not.toContain('zai-coding-cn');
  });

  it('replaces an existing api_key without disturbing the rest of the file', () => {
    const dir = makeAgentDir();
    writeProviderApiKey(dir, { id: 'deepseek', apiKey: 'sk-ds-replaced' });
    const doc = JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8'));
    expect(doc.deepseek).toEqual({ type: 'api_key', key: 'sk-ds-replaced' });
    expect(doc['openai-codex'].type).toBe('oauth');
  });

  it('refuses to overwrite an OAuth login and leaves the file untouched', () => {
    const dir = makeAgentDir();
    const before = fs.readFileSync(path.join(dir, 'auth.json'), 'utf8');
    expect(() => writeProviderApiKey(dir, { id: 'openai-codex', apiKey: 'sk-x' })).toThrow('套餐登录');
    expect(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8')).toBe(before);
  });

  it('clears the key when asked; clearing a missing entry is a no-op', () => {
    const dir = makeAgentDir();
    writeProviderApiKey(dir, { id: 'deepseek', clear: true });
    let doc = JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8'));
    expect(doc.deepseek).toBeUndefined();
    expect(doc['openai-codex']).toBeDefined();
    const before = fs.readFileSync(path.join(dir, 'auth.json'), 'utf8');
    writeProviderApiKey(dir, { id: 'never-configured', clear: true });
    expect(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8')).toBe(before);
    doc = JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8'));
    expect(doc['never-configured']).toBeUndefined();
  });

  it('rejects empty keys and malformed provider ids', () => {
    const dir = makeAgentDir();
    expect(() => writeProviderApiKey(dir, { id: 'deepseek', apiKey: '   ' })).toThrow('请填写');
    expect(() => writeProviderApiKey(dir, { id: 'bad id!', apiKey: 'sk-x' })).toThrow('供应商 ID');
  });
});

describe('models-store.json dynamic catalogs (antigravity)', () => {
  const antigravityEntry = {
    models: [
      {
        id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash (Antigravity)', reasoning: true,
        thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high' },
        input: ['text', 'image'], cost: { input: 0.1, output: 0.4 }, contextWindow: 1048576, maxTokens: 65536,
        api: 'antigravity-api', provider: 'antigravity', baseUrl: 'https://daily-cloudcode-pa.googleapis.com',
      },
    ],
  };

  it('reads OAuth-refreshed provider catalogs the CLI also sees', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-catalog-store-'));
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({}));
    fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ antigravity: { type: 'oauth' } }));
    fs.writeFileSync(path.join(dir, 'models-store.json'), JSON.stringify({ antigravity: antigravityEntry }));
    const catalog = readModelCatalog(dir);
    const ag = catalog.providers.find((p) => p.id === 'antigravity');
    expect(ag, 'antigravity must be visible to Desktop').toBeDefined();
    expect(ag!.source).toBe('models-store.json');
    expect(ag!.auth).toBe('oauth');
    expect(ag!.baseUrl).toBe('https://daily-cloudcode-pa.googleapis.com');
    expect(ag!.models[0]).toMatchObject({ id: 'gemini-3.8-flash', definition: 'builtin', contextWindow: 1048576, reasoning: true });
    expect(ag!.models[0].thinkingLevelMap).toEqual({ off: null, low: 'low', medium: 'medium', high: 'high' });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('lets a models.json definition win over the dynamic catalog', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-catalog-store2-'));
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({}));
    fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify({ providers: { antigravity: { name: 'My AG', api: 'openai-completions', models: [{ id: 'my-model', contextWindow: 4096 }] } } }));
    fs.writeFileSync(path.join(dir, 'models-store.json'), JSON.stringify({ antigravity: antigravityEntry }));
    const ag = readModelCatalog(dir).providers.find((p) => p.id === 'antigravity')!;
    expect(ag.source).toBe('models.json');
    expect(ag.models.map((m) => m.id)).toEqual(['my-model']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('tolerates a malformed models-store.json and stores with no models', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-catalog-store3-'));
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({}));
    fs.writeFileSync(path.join(dir, 'models-store.json'), '{not json');
    expect(readModelCatalog(dir).providers).toEqual([]);
    fs.writeFileSync(path.join(dir, 'models-store.json'), JSON.stringify({ antigravity: { providers: [] }, other: null, 'no-models': {} }));
    expect(readModelCatalog(dir).providers).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('session affinity (compat) persistence', () => {
  it('writes compat through create and modelEdit override, preserving unknown keys', () => {
    const dir = makeAgentDir();
    // create 分支：compat 落到 provider.models[]，未知键透传
    writeModelProvider(dir, {
      id: 'aff-relay', baseUrl: 'https://aff.example.com/v1', api: 'openai-completions',
      models: [{ id: 'm1', compat: { sendSessionAffinityHeaders: true, sessionAffinityFormat: 'openrouter', supportsReasoningEffort: true } }],
    });
    const stored = JSON.parse(fs.readFileSync(path.join(dir, 'models.json'), 'utf8'));
    expect(stored.providers['aff-relay'].models[0].compat).toEqual({ sendSessionAffinityHeaders: true, sessionAffinityFormat: 'openrouter', supportsReasoningEffort: true });
    // modelEdit override 分支：compat 进 modelOverrides 层
    const catalog = writeModelProvider(dir, {
      id: 'aff-relay', baseUrl: '', models: [{ id: 'm1', compat: { sendSessionAffinityHeaders: true } }],
      modelEdit: { originalId: 'm1', kind: 'override', fields: ['compat'] },
    });
    const after = JSON.parse(fs.readFileSync(path.join(dir, 'models.json'), 'utf8'));
    expect(after.providers['aff-relay'].modelOverrides.m1.compat).toEqual({ sendSessionAffinityHeaders: true });
    expect(catalog.providers.find((p) => p.id === 'aff-relay')?.models[0].compat).toEqual({ sendSessionAffinityHeaders: true });
    // 清除：compat undefined + fields 显式含 compat → override 层与定义层都不再带
    writeModelProvider(dir, { id: 'aff-relay', baseUrl: '', models: [{ id: 'm1', compat: undefined }], modelEdit: { originalId: 'm1', kind: 'override', fields: ['compat'] } });
    const cleared = JSON.parse(fs.readFileSync(path.join(dir, 'models.json'), 'utf8'));
    // 覆盖层 compat 清空后整个 m1 覆盖条目被移除（空覆盖不落盘）
    expect(cleared.providers['aff-relay'].modelOverrides?.m1).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects malformed compat without touching models.json', () => {
    const dir = makeAgentDir();
    writeModelProvider(dir, { id: 'aff2', baseUrl: 'https://aff2.example.com/v1', models: [{ id: 'm1' }] });
    const before = fs.readFileSync(path.join(dir, 'models.json'), 'utf8');
    const edit = (model: Record<string, unknown>) => ({ id: 'aff2', baseUrl: '', models: [model], modelEdit: { originalId: 'm1', kind: 'override' as const, fields: ['compat' as const] } });
    expect(() => writeModelProvider(dir, edit({ id: 'm1', compat: [1, 2] as unknown as Record<string, unknown> }))).toThrow('compat');
    expect(() => writeModelProvider(dir, edit({ id: 'm1', compat: { sendSessionAffinityHeaders: 'yes' } }))).toThrow('compat');
    expect(() => writeModelProvider(dir, edit({ id: 'm1', compat: { sessionAffinityFormat: 'nginx' } }))).toThrow('sessionAffinityFormat');
    expect(fs.readFileSync(path.join(dir, 'models.json'), 'utf8')).toBe(before);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
