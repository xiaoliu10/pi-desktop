import type { PiCatalogModel } from '../../../shared/pi';

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
/** 会话亲和三态：default=不发 header；openrouter=x-session-id；anthropic=x-session-affinity。 */
export type SessionAffinity = 'default' | 'openrouter' | 'anthropic';
/** pi compat 里会话亲和占用的两键；其余未知键原样保留。 */
const AFFINITY_KEYS = ['sendSessionAffinityHeaders', 'sessionAffinityFormat'] as const;
export interface ModelDraft {
  id: string; name: string; contextWindow: string; maxTokens: string;
  image: boolean; reasoning: boolean; thinkingLevelMap: string; samplingParams: string;
  sessionAffinity: SessionAffinity;
}
function affinityOf(compat: PiCatalogModel['compat']): SessionAffinity {
  if (compat?.sendSessionAffinityHeaders !== true) return 'default';
  return compat.sessionAffinityFormat === 'openrouter' ? 'openrouter' : 'anthropic';
}
export function createModelDraft(model: PiCatalogModel): ModelDraft {
  return { id: model.id, name: model.name ?? '', contextWindow: String(model.contextWindow ?? ''), maxTokens: String(model.maxTokens ?? ''), image: model.input?.includes('image') ?? false, reasoning: model.reasoning ?? false, thinkingLevelMap: model.thinkingLevelMap ? JSON.stringify(model.thinkingLevelMap, null, 2) : '', samplingParams: model.samplingParamsByThinkingLevel ? JSON.stringify(model.samplingParamsByThinkingLevel, null, 2) : '', sessionAffinity: affinityOf(model.compat) };
}
export type ModelDraftResult = { model: PiCatalogModel } | { field: keyof ModelDraft; message: string };
/** original：编辑时传入被编辑的原始模型，用于保留 compat 未知键；新增模型传缺省。 */
export function commitModelDraft(draft: ModelDraft, others: PiCatalogModel[], original?: PiCatalogModel): ModelDraftResult {
  const id = draft.id.trim();
  if (!id) return { field: 'id', message: '请填写模型 ID。' };
  if (others.some(m=>m.id === id)) return { field: 'id', message: '该模型 ID 已存在。' };
  const numbers: { contextWindow?: number; maxTokens?: number } = {};
  for (const field of ['contextWindow', 'maxTokens'] as const) {
    const value = draft[field].trim();
    if (value && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1)) return { field, message: 'Token 数量必须为正整数。' };
    numbers[field] = value ? Number(value) : undefined;
  }
  if (numbers.contextWindow && numbers.maxTokens && numbers.maxTokens > numbers.contextWindow) return { field: 'maxTokens', message: '最大输出不能超过上下文窗口。' };
  let thinkingLevelMap: PiCatalogModel['thinkingLevelMap'];
  if (draft.thinkingLevelMap.trim()) {
    try {
      const map = JSON.parse(draft.thinkingLevelMap);
      if (!map || Array.isArray(map) || typeof map !== 'object' || Object.entries(map).some(([k,v]) => !THINKING_LEVELS.includes(k as typeof THINKING_LEVELS[number]) || (v !== null && (typeof v !== 'string' || !v.trim())))) throw new Error();
      thinkingLevelMap = map;
    } catch { return { field:'thinkingLevelMap', message:'推理映射必须为 JSON 对象；键为 pi 思考等级，值为非空字符串或 null。' }; }
  }
  let samplingParamsByThinkingLevel: PiCatalogModel['samplingParamsByThinkingLevel'];
  if (draft.samplingParams.trim()) {
    try {
      const params = JSON.parse(draft.samplingParams);
      if (!params || Array.isArray(params) || typeof params !== 'object' || Object.entries(params).some(([k,v]) => !THINKING_LEVELS.includes(k as typeof THINKING_LEVELS[number]) || !v || Array.isArray(v) || typeof v !== 'object')) throw new Error();
      samplingParamsByThinkingLevel = params;
    } catch { return { field:'samplingParams', message:'推理参数映射必须为 JSON 对象；键为 pi 思考等级，值为参数对象（如 {"temperature": 0.7}）。' }; }
  }
  // 会话亲和：改写 compat 的两键、保留未知键；default 且无其余键时不发 compat 字段。
  const priorCompat = original?.compat ?? {};
  let compat: PiCatalogModel['compat'];
  if (draft.sessionAffinity === 'default') {
    const rest = Object.fromEntries(Object.entries(priorCompat).filter(([k]) => !AFFINITY_KEYS.includes(k as typeof AFFINITY_KEYS[number])));
    compat = Object.keys(rest).length ? rest : undefined;
  } else {
    const rest = Object.fromEntries(Object.entries(priorCompat).filter(([k]) => !AFFINITY_KEYS.includes(k as typeof AFFINITY_KEYS[number])));
    compat = { ...rest, sendSessionAffinityHeaders: true, ...(draft.sessionAffinity === 'openrouter' ? { sessionAffinityFormat: 'openrouter' } : {}) };
  }
  return { model:{id, name:draft.name.trim() || undefined, ...numbers, input: draft.image ? ['text','image'] : ['text'], reasoning:draft.reasoning, thinkingLevelMap, samplingParamsByThinkingLevel, compat} };
}
