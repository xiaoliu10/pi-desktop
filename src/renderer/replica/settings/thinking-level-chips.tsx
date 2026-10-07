import { useEffect, useState } from 'react';
import { Icon } from '../Icons';
import { THINKING_LEVELS } from './model-draft';

/**
 * ZCode-style editors for pi's model-level `thinkingLevelMap` and
 * `samplingParamsByThinkingLevel` (models.json). pi's ThinkingLevelMapSchema
 * fixes the key vocabulary (off/minimal/low/medium/high/xhigh/max); what the
 * user customizes is:
 *   - WHICH levels the model exposes (chips + "+" → custom entry count), and
 *   - the exact string sent to the provider per level (detail editor).
 * Availability mirrors pi core getSupportedThinkingLevels:
 *   - off..high are available by default; a `null` entry disables one.
 *   - xhigh/max are unavailable until explicitly given a non-null value.
 * Serialized back to the same JSON-string drafts the dialog already persists,
 * so commitModelDraft validation is reused unchanged.
 */

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
/** string = value sent to provider; null = level disabled; absent = default. */
export type LevelEntries = Partial<Record<ThinkingLevel, string | null>>;
/** Base levels are available without an entry; xhigh/max need one. */
const BASE_LEVELS = new Set<ThinkingLevel>(['off', 'minimal', 'low', 'medium', 'high']);

export type ParsedLevelMap = { entries: LevelEntries; dropped: Array<{ key: string; value: unknown }> };

export function parseLevelMap(json: string): ParsedLevelMap | null {
  if (!json.trim()) return { entries: {}, dropped: [] };
  try {
    const data = JSON.parse(json) as unknown;
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
    const entries: LevelEntries = {};
    const dropped: Array<{ key: string; value: unknown }> = [];
    for (const [key, val] of Object.entries(data as Record<string, unknown>)) {
      // 未知等级：pi runtime 读不到（功能已死），但 commit 校验会拒绝原始串——
      // 保留为 dropped 让行内可见可删，避免「保存报错却无处修」的死角。
      if (!(THINKING_LEVELS as readonly string[]).includes(key)) { dropped.push({ key, value: val }); continue; }
      if (val === null) entries[key as ThinkingLevel] = null;
      else if (typeof val === 'string' && val.trim()) entries[key as ThinkingLevel] = val;
      else dropped.push({ key, value: val });
    }
    return { entries, dropped };
  } catch {
    return null;
  }
}

/** Fixed low→high order, only explicitly configured entries; '' when empty. */
export function serializeLevelMap(entries: LevelEntries): string {
  const ordered = THINKING_LEVELS.filter(level => entries[level] !== undefined);
  if (ordered.length === 0) return '';
  return JSON.stringify(Object.fromEntries(ordered.map(level => [level, entries[level]])), null, 2);
}

/** Mirrors pi core getSupportedThinkingLevels availability rules. */
export function isAvailable(entries: LevelEntries, level: ThinkingLevel): boolean {
  const mapped = entries[level];
  if (mapped === null) return false;
  return BASE_LEVELS.has(level) ? true : mapped !== undefined;
}

/** 勾选切换：基础等级取消=显式禁用（null，pi 视为不可用）；xhigh/max 取消=移除条目（回默认不可用）。
 *  勾选时基础等级空值=回到默认可用；xhigh/max 空值=映射为等级名本身（非空才可用）。 */
export function toggledEntry(entries: LevelEntries, level: ThinkingLevel, checked: boolean): LevelEntries {
  const next: LevelEntries = { ...entries };
  if (!checked) {
    if (BASE_LEVELS.has(level)) next[level] = null; else delete next[level];
    return next;
  }
  const mapped = entries[level];
  const value = typeof mapped === 'string' && mapped.trim() ? mapped.trim() : BASE_LEVELS.has(level) ? undefined : level;
  if (value === undefined) delete next[level]; else next[level] = value;
  return next;
}

/** 文本框改名：清空 = 基础等级移除条目（回默认可用），xhigh/max 回退到等级名本身（保持可用）。 */
export function renamedEntry(entries: LevelEntries, level: ThinkingLevel, text: string): LevelEntries {
  const next: LevelEntries = { ...entries };
  const trimmed = text.trim();
  if (!trimmed) {
    if (BASE_LEVELS.has(level)) delete next[level]; else next[level] = level;
    return next;
  }
  next[level] = trimmed;
  return next;
}

// ============ 推理参数映射（pi 1.0.2+ samplingParamsByThinkingLevel）============

/** Record = per-level params object (e.g. {"temperature":0.7}); absent = none. */
export type SamplingEntries = Partial<Record<ThinkingLevel, Record<string, unknown>>>;

export type ParsedSamplingParams = { entries: SamplingEntries; dropped: Array<{ key: string }> };

export function parseSamplingParams(json: string): ParsedSamplingParams | null {
  if (!json.trim()) return { entries: {}, dropped: [] };
  try {
    const data = JSON.parse(json) as unknown;
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
    const entries: SamplingEntries = {};
    const dropped: Array<{ key: string }> = [];
    for (const [key, val] of Object.entries(data as Record<string, unknown>)) {
      if (!(THINKING_LEVELS as readonly string[]).includes(key) || !val || typeof val !== 'object' || Array.isArray(val)) { dropped.push({ key }); continue; }
      entries[key as ThinkingLevel] = val as Record<string, unknown>;
    }
    return { entries, dropped };
  } catch {
    return null;
  }
}

/** Fixed low→high order, only configured entries; '' when empty. */
export function serializeSamplingParams(entries: SamplingEntries): string {
  const ordered = THINKING_LEVELS.filter(level => entries[level] !== undefined);
  if (ordered.length === 0) return '';
  return JSON.stringify(Object.fromEntries(ordered.map(level => [level, entries[level]])), null, 2);
}

// ============ ZCode 式组件 ============

/** 可用等级列表（供采样参数编辑器提示生效范围）。 */
export function availableLevelsOf(value: string): ThinkingLevel[] {
  const entries = parseLevelMap(value)?.entries ?? {};
  return THINKING_LEVELS.filter(level => isAvailable(entries, level));
}

/** 等级胶囊 chips：可用等级横排，点选展开映射值编辑行；「＋」启用更多等级。 */
export function ThinkingLevelChips({ value, onChange }: { value: string; onChange: (json: string) => void }) {
  const parsed = parseLevelMap(value) ?? { entries: {}, dropped: [] };
  const entries = parsed.entries;
  const [selected, setSelected] = useState<ThinkingLevel | null>(null);
  const [adding, setAdding] = useState(false);
  // 外部值变化（重置表单）后选中项可能已不可用：自动收起，避免编辑悬空条目。
  useEffect(() => {
    if (selected && !isAvailable(entries, selected)) setSelected(null);
    if (selected) setAdding(false);
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  const availableLevels = THINKING_LEVELS.filter(level => isAvailable(entries, level));
  const disabledLevels = THINKING_LEVELS.filter(level => !isAvailable(entries, level));
  const toggle = (level: ThinkingLevel, checked: boolean) => onChange(serializeLevelMap(toggledEntry(entries, level, checked)));
  const rename = (level: ThinkingLevel, text: string) => onChange(serializeLevelMap(renamedEntry(entries, level, text)));

  const removeDropped = (key: string) => {
    // 未知键写回会被 commit 校验拒绝：从原始 JSON 里删掉该键后交给 onChange。
    try {
      const data = JSON.parse(value) as Record<string, unknown>;
      delete data[key];
      onChange(Object.keys(data).length > 0 ? JSON.stringify(data, null, 2) : '');
    } catch { /* parseLevelMap 已通过才会渲染，此处不达 */ }
  };

  const selectedMapped = selected !== undefined && selected !== null ? entries[selected] : undefined;
  return (
    <div className="pi-levels" role="group" aria-label="推理等级（从低到高）">
      <div className="pi-level-chips">
        {availableLevels.map(level => {
          const custom = entries[level] !== undefined && entries[level] !== null;
          return (
            <button key={level} type="button" className="pi-level-chip" data-custom={custom || undefined}
              aria-pressed={selected === level} aria-label={`推理等级 ${level}${custom ? '，已自定义映射' : ''}`}
              onClick={() => setSelected(cur => cur === level ? null : level)}>
              {level}
            </button>
          );
        })}
        <button type="button" className="pi-level-add" aria-label="添加推理等级" aria-expanded={adding}
          onClick={() => { setAdding(v => !v); setSelected(null); }}>
          <Icon name="plus" size={12} />
        </button>
      </div>
      {adding && (
        <div className="pi-level-detail" role="group" aria-label="可添加的推理等级">
          <small>添加等级：</small>
          {disabledLevels.map(level => (
            <button key={level} type="button" className="pi-level-chip pi-level-chip--ghost"
              onClick={() => { toggle(level, true); setSelected(level); setAdding(false); }}>
              {level}
            </button>
          ))}
          {disabledLevels.length === 0 && <small>全部等级已启用</small>}
        </div>
      )}
      {selected && (
        <div className="pi-level-detail">
          <label>
            <span><code>{selected}</code> 发送给服务商的值</span>
            <input type="text" value={typeof selectedMapped === 'string' ? selectedMapped : ''} spellCheck={false}
              placeholder={BASE_LEVELS.has(selected) ? '留空使用 pi 默认映射' : selected}
              aria-label={`${selected} 发送给服务商的值，留空恢复默认`}
              onChange={e => rename(selected, e.target.value)} />
          </label>
          <button type="button" className="pi-level-off" onClick={() => { toggle(selected, false); setSelected(null); }}>
            停用该等级
          </button>
        </div>
      )}
      {parsed.dropped.map(({ key }) => (
        <div key={key} className="pi-level-detail pi-level-detail--dropped" title="pi 不识别该等级；保留会导致保存被拒绝">
          <span><code>{key}</code> <em>（未知等级）</em></span>
          <button type="button" className="pi-level-off" aria-label={`移除未知等级 ${key}`} onClick={() => removeDropped(key)}>移除</button>
        </div>
      ))}
    </div>
  );
}

/** 推理参数映射：等宽代码块编辑（ZCode「推理参数映射」观感），JSON 校验。 */
export function SamplingParamsEditor({ value, onChange, error, availableLevels }: {
  value: string; onChange: (json: string) => void; error?: boolean; availableLevels: ThinkingLevel[];
}) {
  const parsed = parseSamplingParams(value);
  return (
    <div className="pi-sampling">
      <textarea name="samplingParams" rows={6} spellCheck={false} className="pi-sampling__code" value={value}
        aria-invalid={error || parsed === null || undefined} aria-label="推理参数映射 JSON"
        placeholder={'{\n  "high": { "temperature": 0.7 },\n  "max": { "temperature": 1, "top_p": 0.95 }\n}'}
        onChange={e => onChange(e.target.value)} />
      <small>
        {parsed === null
          ? 'JSON 无法解析，请修正格式后保存。'
          : parsed.dropped.length > 0
            ? `存在无效条目（${parsed.dropped.map(d => d.key).join('、')}）：键需为 pi 思考等级，值为参数对象。`
            : availableLevels.length > 0
              ? `按思考等级覆盖采样参数（temperature、top_p 等），仅 ${availableLevels.join('、')} 会生效。留空使用服务商默认。`
              : '按思考等级覆盖采样参数；先在上方启用推理等级。'}
      </small>
    </div>
  );
}
