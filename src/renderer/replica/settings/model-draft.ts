import type { PiCatalogModel } from '../../../shared/pi';

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export interface ModelDraft {
  id: string; name: string; contextWindow: string; maxTokens: string;
  image: boolean; reasoning: boolean; thinkingLevelMap: string;
}
export function createModelDraft(model: PiCatalogModel): ModelDraft {
  return { id: model.id, name: model.name ?? '', contextWindow: String(model.contextWindow ?? ''), maxTokens: String(model.maxTokens ?? ''), image: model.input?.includes('image') ?? false, reasoning: model.reasoning ?? false, thinkingLevelMap: model.thinkingLevelMap ? JSON.stringify(model.thinkingLevelMap, null, 2) : '' };
}
export type ModelDraftResult = { model: PiCatalogModel } | { field: keyof ModelDraft; message: string };
export function commitModelDraft(draft: ModelDraft, others: PiCatalogModel[]): ModelDraftResult {
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
  return { model:{id, name:draft.name.trim() || undefined, ...numbers, input: draft.image ? ['text','image'] : ['text'], reasoning:draft.reasoning, thinkingLevelMap} };
}
