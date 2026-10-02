import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PiCatalogModel, PiCatalogProvider, PiModelCatalog, PiModelEditableField, PiModelProviderDraft } from '../../shared/pi';

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
    const overrides = (raw.modelOverrides ?? {}) as Record<string, Record<string, unknown>>;
    const definitions = Array.isArray(raw.models) ? raw.models as Record<string, unknown>[] : [];
    const entries = [
      ...definitions.map(m => ({ ...m, ...overrides[String(m.id)], id: m.id, definition: 'custom' as const })),
      ...Object.entries(overrides).filter(([id]) => !definitions.some(m => m.id === id)).map(([id, m]) => ({ ...m, id, definition: 'override' as const })),
    ];
    const models: PiCatalogModel[] = entries.map((m: Record<string, unknown>) => ({
          definition: m.definition as PiCatalogModel['definition'],
          id: String(m.id ?? ''),
          name: typeof m.name === 'string' ? m.name : undefined,
          contextWindow: typeof m.contextWindow === 'number' ? m.contextWindow : undefined,
          maxTokens: typeof m.maxTokens === 'number' ? m.maxTokens : undefined,
          reasoning: typeof m.reasoning === 'boolean' ? m.reasoning : undefined,
          thinkingLevelMap: m.thinkingLevelMap && typeof m.thinkingLevelMap === 'object' ? m.thinkingLevelMap as PiCatalogModel['thinkingLevelMap'] : undefined,
          input: Array.isArray(m.input) ? m.input.filter((v): v is string => v === 'text' || v === 'image') : undefined,
        })).filter((m) => m.id);
    providers.push({
      id,
      name: typeof raw.name === 'string' ? raw.name : undefined,
      baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : undefined,
      api: typeof raw.api === 'string' ? raw.api : undefined,
      auth: typeof raw.apiKey === 'string' && raw.apiKey.length > 0 ? 'api_key' : 'none',
      source: definitions.length ? 'models.json' : 'auth',
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

/**
 * Set/clear an API key for a pi built-in provider (auth.json, shared with the pi CLI).
 * Other providers' credentials are preserved; OAuth logins are never overwritten
 * (replacing them with a key would silently destroy the subscription token).
 */
export function writeProviderApiKey(agentDir: string, input: { id: string; apiKey?: string; clear?: boolean }): PiModelCatalog {
  const id = input.id.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) throw new Error('无效的供应商 ID');
  const file = path.join(agentDir, 'auth.json');
  let doc: Record<string, unknown> = {};
  const raw = readJson(file);
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) doc = raw;
  const existing = doc[id];
  if (existing && typeof existing === 'object' && !Array.isArray(existing) && (existing as Record<string, unknown>).type === 'oauth') {
    throw new Error('该供应商已使用套餐登录，不能替换为 API Key（会丢失登录凭证）。');
  }
  if (input.clear) {
    if (!existing) return readModelCatalog(agentDir);
    delete doc[id];
  } else {
    const key = input.apiKey?.trim();
    if (!key) throw new Error('请填写 API Key。');
    doc[id] = { type: 'api_key', key };
  }
  writeJson(file, doc, true);
  return readModelCatalog(agentDir);
}

const editableFields: PiModelEditableField[] = ['name', 'contextWindow', 'maxTokens', 'reasoning', 'input', 'thinkingLevelMap'];

/** Missing/unreadable/malformed are not equivalent when saving a secret-bearing file. */
function readModelsForWrite(file: string): Record<string, unknown> {
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!doc || typeof doc !== 'object' || Array.isArray(doc) || (doc.providers !== undefined && (!doc.providers || typeof doc.providers !== 'object' || Array.isArray(doc.providers)))) throw new Error();
    return doc;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error('无法安全读取 models.json；未保存，请检查文件后重试。');
  }
}

/** Apply only named fields; undefined clears only when explicitly named by the editor. */
function patchModel(prior: Record<string, unknown>, model: PiCatalogModel, fields: PiModelEditableField[]): Record<string, unknown> {
  const entry = { ...prior };
  for (const key of fields) {
    if (!editableFields.includes(key)) throw new Error('不支持的模型字段');
    const value = model[key];
    if (value === undefined || (key === 'name' && !String(value).trim())) delete entry[key];
    else entry[key] = key === 'name' ? String(value).trim() : value;
  }
  return entry;
}
function validateLimits(model: Record<string, unknown>, fallback: Partial<PiCatalogModel> = {}): void {
  const context = model.contextWindow ?? fallback.contextWindow ?? 128000;
  const output = model.maxTokens ?? fallback.maxTokens ?? 16384;
  if (typeof context !== 'number' || typeof output !== 'number' || !Number.isSafeInteger(context) || !Number.isSafeInteger(output) || context <= 0 || output <= 0) throw new Error('上下文窗口和最大输出必须为正整数');
  if (output > context) throw new Error('最大输出不能超过上下文窗口，请同时调整最大输出。');
}

/** Merge runtime metadata with explicit local values, scoped by provider AND model ID. */
export function mergeModelCatalog(catalog: PiModelCatalog, native: PiCatalogProvider[]): PiModelCatalog {
  for (const provider of native) {
    const existing = catalog.providers.find(p => p.id === provider.id);
    if (!existing) { catalog.providers.push(provider); continue; }
    existing.loginAvailable = provider.loginAvailable;
    if (existing.auth === 'none') existing.auth = provider.auth;
    existing.name ??= provider.name;
    existing.imageModels = provider.imageModels; // 生图模型只来自运行时目录，本地 models.json 不参与
    const local = new Map(existing.models.map(m => [m.id, m]));
    existing.models = provider.models.map(m => {
      const configured = local.get(m.id);
      local.delete(m.id);
      return { ...m, ...Object.fromEntries(Object.entries(configured ?? {}).filter(([, value]) => value !== undefined)), definition: configured?.definition ?? 'override' } as PiCatalogModel;
    });
    existing.models.push(...local.values());
  }
  return catalog;
}

/** Create or update a custom provider in models.json. Empty apiKey keeps the stored one. */
export function writeModelProvider(agentDir: string, draft: PiModelProviderDraft): PiModelCatalog {
  const id = draft.id.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) throw new Error('提供商 ID 只能包含字母、数字、- 和 _，且以字母或数字开头');
  if (!draft.modelEdit && (!draft.baseUrl?.trim() || !/^https?:\/\//.test(draft.baseUrl.trim()))) throw new Error('Base URL 必须以 http(s):// 开头');
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
  const doc = readModelsForWrite(file);
  const providers = (doc.providers ?? {}) as Record<string, Record<string, unknown>>;
  const existing = providers[id] ?? {};
  if (draft.modelEdit) {
    if (models.length !== 1) throw new Error('每次只能编辑一个模型');
    const model = models[0], edit = draft.modelEdit;
    if (edit.kind !== 'custom' && edit.kind !== 'override') throw new Error('无效的模型编辑类型');
    if (edit.fields !== undefined && !Array.isArray(edit.fields)) throw new Error('无效的模型编辑字段');
    if (edit.originalId && edit.originalId !== model.id) throw new Error('不能修改已有模型 ID');
    const definitions = Array.isArray(existing.models) ? existing.models as Record<string, unknown>[] : [];
    const index = definitions.findIndex(m => m.id === model.id);
    if (edit.kind === 'custom' && edit.originalId && index < 0) throw new Error('模型已被移除，请刷新后重试。');
    if (!edit.originalId && index >= 0) throw new Error('该模型 ID 已存在。');
    const fields = edit.fields ?? editableFields.filter(key => model[key] !== undefined);
    const overrides = { ...(existing.modelOverrides as Record<string, Record<string, unknown>> ?? {}) };
    const priorOverride = overrides[model.id] ?? {};
    const override = patchModel(priorOverride, model, fields);
    const custom = index >= 0 || (edit.kind === 'custom' && !edit.originalId);
    const entry = custom ? { ...patchModel(definitions[index] ?? {}, model, fields), id: model.id } : undefined;
    // Runtime defaults/discovery are only validation fallbacks, never copied into models.json.
    validateLimits({ ...entry, ...override }, custom ? {} : model);
    if (entry) {
      if (index < 0 && (!existing.baseUrl || !existing.api)) throw new Error('自定义提供商缺少 Base URL 或 API');
      const next = [...definitions];
      if (index >= 0) next[index] = entry; else next.push(entry);
      existing.models = next;
    }
    if (Object.keys(override).length) overrides[model.id] = override; else delete overrides[model.id];
    if (Object.keys(overrides).length) existing.modelOverrides = overrides; else delete existing.modelOverrides;
    providers[id] = existing;
    doc.providers = providers;
    writeJson(file, doc, true);
    return readModelCatalog(agentDir);
  }
  const apiKey = typeof draft.apiKey === 'string' && draft.apiKey.length > 0 ? draft.apiKey : existing.apiKey;
  const overrides = { ...(existing.modelOverrides as Record<string, Record<string, unknown>> ?? {}) };
  providers[id] = {
    ...existing,
    modelOverrides: overrides,
    name: draft.name?.trim() || existing.name || id,
    baseUrl: draft.baseUrl.trim(),
    api: draft.api?.trim() || (typeof existing.api === 'string' && existing.api) || 'openai-completions',
    apiKey,
    models: models.map((m) => {
      // Keep protocol, pricing, headers and compatibility settings not edited by Desktop.
      const prior = Array.isArray(existing.models) ? existing.models.find((v: Record<string, unknown>) => v.id === m.id) : undefined;
      const entry: Record<string, unknown> = { ...prior, id: m.id };
      if (m.name?.trim()) entry.name = m.name.trim();
      if (m.contextWindow !== undefined) entry.contextWindow = m.contextWindow;
      if (m.maxTokens !== undefined) entry.maxTokens = m.maxTokens;
      if (m.reasoning !== undefined) entry.reasoning = m.reasoning === true;
      if (m.input !== undefined) entry.input = [...new Set(m.input)];
      if (m.thinkingLevelMap !== undefined) entry.thinkingLevelMap = m.thinkingLevelMap;
      else if (Object.hasOwn(m, 'thinkingLevelMap')) delete entry.thinkingLevelMap;
      // Explicit Desktop edits must also update the runtime's topmost config layer.
      const fields = editableFields.filter(key => m[key] !== undefined || key === 'thinkingLevelMap' && Object.hasOwn(m, key));
      const override = patchModel(overrides[m.id] ?? {}, m, fields);
      validateLimits({ ...entry, ...override });
      if (Object.keys(override).length) overrides[m.id] = override; else delete overrides[m.id];
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
