import { THINKING_LEVELS } from './model-draft';

/**
 * ZCode-style editable rows for pi's model-level `thinkingLevelMap`
 * (models.json). pi's ThinkingLevelMapSchema fixes the key vocabulary
 * (off/minimal/low/medium/high/xhigh/max); what the user customizes is:
 *   - WHICH levels the model exposes (checkbox per row → custom entry count), and
 *   - the exact string sent to the provider per level (text box per row).
 * Availability mirrors pi core getSupportedThinkingLevels:
 *   - off..high are available by default; a `null` entry disables one.
 *   - xhigh/max are unavailable until explicitly given a non-null value.
 * Serialized back to the same JSON-string draft the dialog already persists,
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

/** ZCode 式行编辑：每行 = 启用复选框 + 等级名 + 映射值文本框（留空 = pi 默认）。
 *  勾选即添加条目（xhigh/max 由此进入列表 → 个数自定义），取消勾选即移除/禁用。 */
export function ThinkingLevelChips({ value, onChange }: { value: string; onChange: (json: string) => void }) {
  const parsed = parseLevelMap(value) ?? { entries: {}, dropped: [] };
  const entries = parsed.entries;

  const setEntry = (level: ThinkingLevel, mapped: string | null | undefined) => {
    const next: LevelEntries = { ...entries };
    if (mapped === undefined) delete next[level];
    else next[level] = mapped;
    onChange(serializeLevelMap(next));
  };

  const toggle = (level: ThinkingLevel, checked: boolean) => onChange(serializeLevelMap(toggledEntry(entries, level, checked)));
  const rename = (level: ThinkingLevel, text: string) => onChange(serializeLevelMap(renamedEntry(entries, level, text)));

  const removeDropped = (key: string) => {
    // 未知键写回会被 commit 校验拒绝：从原始 JSON 里删掉该键后交给 onChange。
    try {
      const data = JSON.parse(value) as Record<string, unknown>;
      delete data[key];
      const rest = Object.keys(data).length > 0 ? JSON.stringify(data, null, 2) : '';
      onChange(rest);
    } catch { /* parseLevelMap 已通过才会渲染行，此处不达 */ }
  };

  return (
    <div className="pi-levels pi-levels--rows" role="group" aria-label="推理等级（从低到高）">
      {THINKING_LEVELS.map(level => {
        const mapped = entries[level];
        const available = isAvailable(entries, level);
        const explicit = mapped !== undefined;
        return (
          <label key={level} className="pi-level-row" data-state={mapped === null ? 'disabled' : explicit ? 'custom' : available ? 'default' : 'off'}>
            <input
              type="checkbox"
              checked={available}
              aria-label={`启用推理等级 ${level}`}
              onChange={e => toggle(level, e.target.checked)}
            />
            <span className="pi-level-rowname">{level}</span>
            <input
              type="text"
              value={typeof mapped === 'string' ? mapped : ''}
              disabled={!available}
              placeholder={available ? (BASE_LEVELS.has(level) ? '默认映射' : level) : '未启用'}
              aria-label={`${level} 发送给服务商的值，留空恢复默认`}
              spellCheck={false}
              onChange={e => rename(level, e.target.value)}
            />
          </label>
        );
      })}
      {parsed.dropped.map(({ key }) => (
        <div key={key} className="pi-level-row pi-level-row--dropped" title="pi 不识别该等级；保留会导致保存被拒绝">
          <span className="pi-level-rowname">{key} <em>（未知等级）</em></span>
          <button type="button" className="pi-level-x" aria-label={`移除未知等级 ${key}`} onClick={() => removeDropped(key)}>×</button>
        </div>
      ))}
    </div>
  );
}
