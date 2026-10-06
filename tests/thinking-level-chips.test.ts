import { describe, expect, it } from 'vitest';
import { isAvailable, parseLevelMap, serializeLevelMap } from '../src/renderer/replica/settings/thinking-level-chips';

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
