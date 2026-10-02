// 模型菜单展示规约：无筛选每组截前 MODEL_MENU_LIMIT 个；筛选=名称/ID/供应商名匹配。
// openrouter 这类几百个模型的供应商靠输入名称定位，键盘上下在可见项内循环。
import { describe, expect, it } from 'vitest';
import { filterModelGroups, groupImageModels, MODEL_MENU_LIMIT } from '../src/renderer/replica/chat/helpers';

const groups = [
  { provider: 'openai', models: [{ id: 'openai/gpt-6.1-sol', name: 'OpenAI: GPT-6.1 Sol' }, { id: 'openai/gpt-6-sol', name: 'OpenAI: GPT-6 Sol' }] },
  { provider: 'openrouter', models: Array.from({ length: 137 }, (_, i) => ({ id: `openrouter/meta-llama/llama-${i}`, name: `Meta: Llama model ${i}` })) },
  { provider: '空组', models: [] },
];

describe('filterModelGroups', () => {
  it('truncates each provider to the limit and reports the remainder without a query', () => {
    const result = filterModelGroups(groups, '');
    expect(result).toHaveLength(2); // 空组剔除
    const openrouter = result.find(g => g.provider === 'openrouter')!;
    expect(openrouter.models).toHaveLength(MODEL_MENU_LIMIT);
    expect(openrouter.truncated).toBe(137 - MODEL_MENU_LIMIT);
    expect(openrouter.total).toBe(137);
    const openai = result.find(g => g.provider === 'openai')!;
    expect(openai.truncated).toBe(0);
    expect(openai.models).toHaveLength(2);
  });

  it('matches by model name or id across groups without truncation', () => {
    const result = filterModelGroups(groups, 'LLAMA-3');
    const openrouter = result.find(g => g.provider === 'openrouter')!;
    expect(openrouter.truncated).toBe(0);
    expect(openrouter.models.every(m => m.name.toLowerCase().includes('llama-3') || m.id.toLowerCase().includes('llama-3'))).toBe(true);
    expect(filterModelGroups(groups, 'gpt-6.1')[0].models.map(m => m.id)).toEqual(['openai/gpt-6.1-sol']);
  });

  it('matches by provider name and then shows the whole group', () => {
    const result = filterModelGroups(groups, 'openrouter');
    expect(result).toHaveLength(1);
    expect(result[0]!.models).toHaveLength(137);
    expect(result[0]!.truncated).toBe(0);
  });

  it('returns nothing for a query that matches neither providers nor models', () => {
    expect(filterModelGroups(groups, '不存在的模型')).toEqual([]);
  });
});

describe('groupImageModels', () => {
  it('groups by provider preserving catalog order and keeps keys intact', () => {
    const grouped = groupImageModels([
      { key: 'openrouter/seedream-4', provider: 'openrouter', providerName: 'openrouter', name: 'Seedream 4' },
      { key: 'zai/cogview-4', provider: 'zai', providerName: '智谱 Z.ai', name: 'CogView-4' },
      { key: 'openrouter/gemini-image', provider: 'openrouter', providerName: 'openrouter', name: 'Gemini Image' },
    ]);
    expect(grouped.map(g => g.provider)).toEqual(['openrouter', '智谱 Z.ai']);
    expect(grouped[0]!.models.map(m => m.id)).toEqual(['openrouter/seedream-4', 'openrouter/gemini-image']);
  });

  it('feeds straight into filterModelGroups (same truncation and query rules)', () => {
    const grouped = groupImageModels([
      { key: 'openrouter/img-1', provider: 'openrouter', providerName: 'openrouter', name: 'Image 1' },
    ]);
    const shown = filterModelGroups(grouped, '');
    expect(shown[0]!.truncated).toBe(0);
    expect(filterModelGroups(grouped, 'image')[0]!.models[0]!.id).toBe('openrouter/img-1');
    expect(filterModelGroups(grouped, '没有')).toEqual([]);
  });
});
