import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PiCatalogModel, PiCatalogProvider, PiModelCatalog, PiModelProviderDraft } from '../../shared/pi';

/**
 * Read/write view of the local pi model configuration:
 *   <agentDir>/settings.json → default provider / model
 *   <agentDir>/models.json   → custom providers + model definitions
 *   <agentDir>/auth.json     → provider auth (type/presence only)
 *
 * Secrets (api keys, oauth tokens, custom headers) are never copied into the
 * returned structure — each provider exposes auth *kind* only. Writes go to
 * settings.json / models.json atomically; pi CLI reads the same files, so the
 * two stay in sync. models.json holds API keys and is written 0600.
 */

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function writeJson(file: string, doc: Record<string, unknown>, secret = false): void {
  const tmp = `${file}.tmp-${randomUUID().slice(0, 8)}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: secret ? 0o600 : 0o644 });
  fs.renameSync(tmp, file);
  if (secret && fs.existsSync(file)) fs.chmodSync(file, 0o600);
}

export function readModelCatalog(agentDir: string): PiModelCatalog {
  const settings = readJson(path.join(agentDir, 'settings.json')) ?? {};
  const modelsDoc = readJson(path.join(agentDir, 'models.json')) ?? {};
  const auth = readJson(path.join(agentDir, 'auth.json')) ?? {};

  const providers: PiCatalogProvider[] = [];
  const seen = new Set<string>();

  const customProviders = (modelsDoc.providers ?? {}) as Record<string, Record<string, unknown>>;
  for (const [id, raw] of Object.entries(customProviders)) {
    if (!raw || typeof raw !== 'object') continue;
    seen.add(id);
    const models: PiCatalogModel[] = Array.isArray(raw.models)
      ? (raw.models as Record<string, unknown>[]).map((m) => ({
          id: String(m.id ?? ''),
          name: typeof m.name === 'string' ? m.name : undefined,
          contextWindow: typeof m.contextWindow === 'number' ? m.contextWindow : undefined,
          maxTokens: typeof m.maxTokens === 'number' ? m.maxTokens : undefined,
          reasoning: m.reasoning === true,
          thinkingLevelMap: m.thinkingLevelMap && typeof m.thinkingLevelMap === 'object' ? m.thinkingLevelMap as PiCatalogModel['thinkingLevelMap'] : undefined,
          input: Array.isArray(m.input) ? m.input.filter((v): v is string => v === 'text' || v === 'image') : undefined,
        })).filter((m) => m.id)
      : [];
    providers.push({
      id,
      name: typeof raw.name === 'string' ? raw.name : undefined,
      baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : undefined,
      api: typeof raw.api === 'string' ? raw.api : undefined,
      auth: typeof raw.apiKey === 'string' && raw.apiKey.length > 0 ? 'api_key' : 'none',
      source: 'models.json',
      models,
    });
  }

  for (const [id, raw] of Object.entries(auth)) {
    if (!raw || typeof raw !== 'object' || seen.has(id)) continue;
    const type = String((raw as Record<string, unknown>).type ?? '');
    providers.push({
      id,
      auth: type === 'oauth' ? 'oauth' : type === 'api_key' ? 'api_key' : 'none',
      source: 'auth',
      models: [],
    });
  }

  return {
    defaultProvider: typeof settings.defaultProvider === 'string' ? settings.defaultProvider : undefined,
    defaultModel: typeof settings.defaultModel === 'string' ? settings.defaultModel : undefined,
    providers,
  };
}

/** Set or clear the default provider/model in settings.json, preserving other fields. */
export function writeDefaultModel(agentDir: string, input: { provider?: string; model?: string }): PiModelCatalog {
  const file = path.join(agentDir, 'settings.json');
  const doc = readJson(file) ?? {};
  const setOrDelete = (key: string, value: string | undefined) => {
    const trimmed = value?.trim();
    if (trimmed) doc[key] = trimmed; else delete doc[key];
  };
  setOrDelete('defaultProvider', input.provider);
  setOrDelete('defaultModel', input.model);
  writeJson(file, doc);
  return readModelCatalog(agentDir);
}

/** Create or update a custom provider in models.json. Empty apiKey keeps the stored one. */
export function writeModelProvider(agentDir: string, draft: PiModelProviderDraft): PiModelCatalog {
  const id = draft.id.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) throw new Error('提供商 ID 只能包含字母、数字、- 和 _，且以字母或数字开头');
  if (!draft.baseUrl?.trim() || !/^https?:\/\//.test(draft.baseUrl.trim())) throw new Error('Base URL 必须以 http(s):// 开头');
  const seen = new Set<string>();
  const models = (draft.models ?? []).map(m => {
    const model = {...m, id: String(m.id ?? '').trim()};
    if (!model.id) throw new Error('请填写模型 ID');
    if (seen.has(model.id)) throw new Error(`模型 ID 重复：${model.id}`);
    seen.add(model.id);
    for (const key of ['contextWindow', 'maxTokens'] as const) {
      const value = model[key];
      if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) throw new Error('上下文窗口和最大输出必须为正整数');
    }
    if (model.contextWindow && model.maxTokens && model.maxTokens > model.contextWindow) throw new Error('最大输出不能超过上下文窗口');
    if (model.input !== undefined && (!Array.isArray(model.input) || !model.input.includes('text') || model.input.some(v => v !== 'text' && v !== 'image'))) throw new Error('输入类型仅支持文本和图片，且必须包含文本');
    if (model.thinkingLevelMap !== undefined) {
      const map = model.thinkingLevelMap;
      if (!map || Array.isArray(map) || typeof map !== 'object' || Object.entries(map).some(([k,v]) => !['off','minimal','low','medium','high','xhigh','max'].includes(k) || (v !== null && (typeof v !== 'string' || !v.trim())))) throw new Error('推理等级映射无效');
    }
    return model;
  });
  if (!models.length) throw new Error('至少需要一个模型');

  const file = path.join(agentDir, 'models.json');
  const doc = readJson(file) ?? {};
  const providers = (doc.providers ?? {}) as Record<string, Record<string, unknown>>;
  const existing = providers[id] ?? {};
  const apiKey = typeof draft.apiKey === 'string' && draft.apiKey.length > 0 ? draft.apiKey : existing.apiKey;
  providers[id] = {
    ...existing,
    name: draft.name?.trim() || id,
    baseUrl: draft.baseUrl.trim(),
    api: draft.api?.trim() || (typeof existing.api === 'string' && existing.api) || 'openai-completions',
    apiKey,
    models: models.map((m) => {
      // Keep protocol, pricing, headers and compatibility settings not edited by Desktop.
      const prior = Array.isArray(existing.models) ? existing.models.find((v: Record<string, unknown>) => v.id === m.id) : undefined;
      const entry: Record<string, unknown> = { ...prior, id: m.id };
      if (m.name?.trim()) entry.name = m.name.trim(); else delete entry.name;
      if (m.contextWindow !== undefined) entry.contextWindow = m.contextWindow; else delete entry.contextWindow;
      if (m.maxTokens !== undefined) entry.maxTokens = m.maxTokens; else delete entry.maxTokens;
      if (m.reasoning !== undefined) entry.reasoning = m.reasoning === true;
      if (m.input !== undefined) entry.input = [...new Set(m.input)];
      if (m.thinkingLevelMap !== undefined) entry.thinkingLevelMap = m.thinkingLevelMap; else delete entry.thinkingLevelMap;
      return entry;
    }),
  };
  doc.providers = providers;
  writeJson(file, doc, true);
  return readModelCatalog(agentDir);
}

/** Remove a custom provider from models.json. OAuth/auth entries are untouched. */
export function removeModelProvider(agentDir: string, id: string): PiModelCatalog {
  const file = path.join(agentDir, 'models.json');
  const doc = readJson(file);
  if (doc?.providers && typeof doc.providers === 'object' && (id in (doc.providers as Record<string, unknown>))) {
    delete (doc.providers as Record<string, unknown>)[id];
    writeJson(file, doc, true);
  }
  return readModelCatalog(agentDir);
}
