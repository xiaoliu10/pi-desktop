import { describe, expect, it } from 'vitest';
import { availableLevelsOf, isAvailable, parseLevelMap, parseSamplingParams, renamedEntry, serializeLevelMap, serializeSamplingParams, toggledEntry } from '../src/renderer/replica/settings/thinking-level-chips';

// ZCode 式推理等级 chips 的数据层：draft JSON 字符串 ↔ 结构化条目。
// pi 语义（getSupportedThinkingLevels）：off–high 默认可用（null 才禁用），
// xhigh/max 需显式条目才可用；值 = 发给服务商的字符串。

describe('parseLevelMap', () => {
  it('空串/空白 → 空条目（未配置 = pi 默认）', () => {
    expect(parseLevelMap('')).toEqual({ entries: {}, dropped: [] });
    expect(parseLevelMap('  ')).toEqual({ entries: {}, dropped: [] });
  });

  it('解析字符串值与 null 禁用', () => {
    expect(parseLevelMap('{"high":"high","xhigh":"max","medium":null}').entries).toEqual({
      high: 'high', xhigh: 'max', medium: null,
    });
  });

  it('未知等级键进 dropped（commit 校验拒绝原始串，chips 必须可见可删）', () => {
    const parsed = parseLevelMap('{"ultra":"max","high":"high"}');
    expect(parsed.entries).toEqual({ high: 'high' });
    expect(parsed.dropped).toEqual([{ key: 'ultra', value: 'max' }]);
  });

  it('坏 JSON / 非对象 / 数组 → null（UI 回落 textarea 修复）', () => {
    expect(parseLevelMap('{bad')).toBeNull();
    expect(parseLevelMap('null')).toBeNull();
    expect(parseLevelMap('[]')).toBeNull();
  });

  it('空字符串值视为未配置（进 dropped，不写入条目）', () => {
    const parsed = parseLevelMap('{"high":""}');
    expect(parsed.entries).toEqual({});
    expect(parsed.dropped).toEqual([{ key: 'high', value: '' }]);
  });
});

describe('isAvailable（镜像 pi getSupportedThinkingLevels）', () => {
  const avail = (entries: Parameters<typeof isAvailable>[0], level: Parameters<typeof isAvailable>[1]) => isAvailable(entries, level);
  it('基础五级默认可用，null 禁用', () => {
    expect(avail({}, 'low')).toBe(true);
    expect(avail({ low: null }, 'low')).toBe(false);
  });
  it('xhigh/max 需显式条目', () => {
    expect(avail({}, 'xhigh')).toBe(false);
    expect(avail({ xhigh: 'max' }, 'xhigh')).toBe(true);
    expect(avail({ max: null }, 'max')).toBe(false);
  });
});

describe('serializeLevelMap', () => {
  it('固定 low→high 顺序，仅含显式条目', () => {
    const json = serializeLevelMap({ xhigh: 'max', medium: null, high: 'hi' });
    expect(JSON.parse(json)).toEqual({ medium: null, high: 'hi', xhigh: 'max' });
    expect(Object.keys(JSON.parse(json))).toEqual(['medium', 'high', 'xhigh']);
  });

  it('空条目 → 空串（draft 留空 = 使用 pi 默认映射）', () => {
    expect(serializeLevelMap({})).toBe('');
  });
});

describe('parseSamplingParams / serializeSamplingParams', () => {
  it('空串 → 空条目；合法对象按键收条目', () => {
    expect(parseSamplingParams('')).toEqual({ entries: {}, dropped: [] });
    expect(parseSamplingParams('{"high":{"temperature":0.7},"max":{"temperature":1}}')?.entries).toEqual({ high: { temperature: 0.7 }, max: { temperature: 1 } });
  });
  it('未知键 / 非对象值进 dropped', () => {
    expect(parseSamplingParams('{"nope":{"a":1},"high":"str","low":null}')?.dropped.map(d => d.key)).toEqual(['nope', 'high', 'low']);
  });
  it('坏 JSON / 数组 → null', () => {
    expect(parseSamplingParams('{')).toBeNull();
    expect(parseSamplingParams('[]')).toBeNull();
  });
  it('serialize 固定 low→high 顺序；空 → 空串；roundtrip 稳定', () => {
    expect(serializeSamplingParams({ max: { temperature: 1 }, high: { temperature: 0.7 } })).toBe(JSON.stringify({ high: { temperature: 0.7 }, max: { temperature: 1 } }, null, 2));
    expect(serializeSamplingParams({})).toBe('');
    const json = serializeSamplingParams({ high: { temperature: 0.7 } });
    expect(serializeSamplingParams(parseSamplingParams(json)!.entries)).toBe(json);
  });
});

describe('availableLevelsOf', () => {
  it('默认五级可用；xhigh/max 配置后进入列表', () => {
    expect(availableLevelsOf('')).toEqual(['off', 'minimal', 'low', 'medium', 'high']);
    expect(availableLevelsOf('{"max":"max"}')).toEqual(['off', 'minimal', 'low', 'medium', 'high', 'max']);
    expect(availableLevelsOf('{"low":null}')).toEqual(['off', 'minimal', 'medium', 'high']);
  });
});

describe('roundtrip 与 pi 可用性语义对齐', () => {
  it('ZCode 截图场景：disabled/enabled/max 三级自定义', () => {
    const { entries } = parseLevelMap(serializeLevelMap({ off: null, low: 'enabled', max: 'max' }));
    // off 禁用、low 自定义值、max 显式添加；xhigh/high 等保持默认可用（off..high 基础级语义）
    expect((['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const).filter(l => isAvailable(entries, l)))
      .toEqual(['minimal', 'low', 'medium', 'high', 'max']);
  });

  it('roundtrip 保持条目不变', () => {
    const src = { off: null, low: 'enabled', xhigh: 'deep' } as const;
    const { entries } = parseLevelMap(serializeLevelMap(src));
    expect(entries).toEqual(src);
  });
});

describe('toggledEntry / renamedEntry（行式编辑语义）', () => {
  it('取消勾选：基础等级显式禁用（null），xhigh/max 移除条目', () => {
    expect(toggledEntry({}, 'low', false)).toEqual({ low: null });
    expect(toggledEntry({ xhigh: 'max' }, 'xhigh', false)).toEqual({});
  });

  it('勾选：基础等级空值回默认（移除条目），xhigh/max 空值映射为等级名', () => {
    expect(toggledEntry({ low: null }, 'low', true)).toEqual({});
    expect(toggledEntry({}, 'xhigh', true)).toEqual({ xhigh: 'xhigh' });
  });

  it('勾选保留已有自定义文本；改名写入并 trim', () => {
    expect(toggledEntry({ high: 'high_effort' }, 'high', true)).toEqual({ high: 'high_effort' });
    expect(renamedEntry({}, 'low', '  effort-low  ')).toEqual({ low: 'effort-low' });
  });

  it('清空文本：基础等级移除条目（回默认可用），xhigh/max 回退等级名（保持可用）', () => {
    expect(renamedEntry({ low: 'custom' }, 'low', '')).toEqual({});
    expect(renamedEntry({ xhigh: 'deep' }, 'xhigh', '   ')).toEqual({ xhigh: 'xhigh' });
    expect(isAvailable(renamedEntry({ xhigh: 'deep' }, 'xhigh', ''), 'xhigh')).toBe(true);
  });
});
