import { useEffect, useState } from 'react';
import { THINKING_LEVELS } from './model-draft';

/**
 * ZCode-style editable chips for pi's model-level `thinkingLevelMap`
 * (models.json). pi validates a fixed level vocabulary
 * (off/minimal/low/medium/high/xhigh/max); the customizable part is each
 * level's mapped value — the exact string sent to the provider — plus
 * availability semantics (pi core getSupportedThinkingLevels):
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
      // 保留为 dropped 让 chips 可见可删，避免「保存报错却无处修」的死角。
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

export function ThinkingLevelChips({ value, onChange }: { value: string; onChange: (json: string) => void }) {
  const parsed = parseLevelMap(value) ?? { entries: {}, dropped: [] };
  const entries = parsed.entries;
  const [editing, setEditing] = useState<ThinkingLevel | null>(null);
  const [draftValue, setDraftValue] = useState('');
  const [draftDisabled, setDraftDisabled] = useState(false);
  const [adding, setAdding] = useState(false);

  // 外部改值（如「恢复 pi 默认」重置 draft）时关闭编辑态，避免陈旧输入把
  // 刚被清掉的条目复活写回。
  useEffect(() => { setEditing(null); setAdding(false); }, [value]);

  const setEntry = (level: ThinkingLevel, mapped: string | null | undefined) => {
    const next: LevelEntries = { ...entries };
    if (mapped === undefined) delete next[level];
    else next[level] = mapped;
    onChange(serializeLevelMap(next));
  };

  const openEditor = (level: ThinkingLevel) => {
    const mapped = entries[level];
    setEditing(level);
    setAdding(false);
    setDraftDisabled(mapped === null);
    setDraftValue(typeof mapped === 'string' ? mapped : '');
  };

  const saveEditor = () => {
    if (!editing) return;
    const level = editing;
    setEditing(null);
    if (draftDisabled) { setEntry(level, null); return; }
    if (!draftValue.trim()) { setEntry(level, undefined); return; }
    setEntry(level, draftValue.trim());
  };

  const removeDropped = (key: string) => {
    // 未知键写回会被 commit 校验拒绝：从原始 JSON 里删掉该键后交给 onChange。
    try {
      const data = JSON.parse(value) as Record<string, unknown>;
      delete data[key];
      const rest = Object.keys(data).length > 0 ? JSON.stringify(data, null, 2) : '';
      onChange(rest);
    } catch { /* parseLevelMap 已通过才会渲染 chips，此处不达 */ }
  };

  const addable = THINKING_LEVELS.filter(level => !isAvailable(entries, level));

  return (
    <div className="pi-levels" role="group" aria-label="推理等级（从低到高）">
      {THINKING_LEVELS.filter(level => isAvailable(entries, level)).map(level => {
        const mapped = entries[level];
        const custom = typeof mapped === 'string' && mapped !== level;
        return (
          <span key={level} className="pi-level-chip" data-state={mapped === null ? 'disabled' : custom ? 'custom' : 'default'}>
            {editing === level ? (
              <span className="pi-level-edit">
                <b>{level}</b>
                <input
                  value={draftValue}
                  placeholder={level}
                  aria-label={`${level} 发送给服务商的值，留空恢复默认`}
                  autoFocus
                  spellCheck={false}
                  onChange={e => setDraftValue(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); saveEditor(); } }}
                />
                <label className="pi-level-disable"><input type="checkbox" checked={draftDisabled} onChange={e => setDraftDisabled(e.target.checked)} />禁用</label>
                <button type="button" className="pi-level-ok" onClick={saveEditor}>完成</button>
                {mapped !== undefined && <button type="button" className="pi-level-x" aria-label={`移除 ${level} 条目`} onClick={() => { setEditing(null); setEntry(level, undefined); }}>×</button>}
              </span>
            ) : (
              <>
                <button type="button" className="pi-level-name" onClick={() => openEditor(level)} title={`点击编辑 ${level} 的映射`}>
                  {level}{custom && <em>→ {mapped}</em>}{mapped === null && <em>已禁用</em>}
                </button>
                {mapped !== undefined && <button type="button" className="pi-level-x" aria-label={`移除 ${level}`} onClick={() => { if (editing === level) setEditing(null); setEntry(level, undefined); }}>×</button>}
              </>
            )}
          </span>
        );
      })}
      {parsed.dropped.map(({ key }) => (
        <span key={key} className="pi-level-chip" data-state="dropped" title="pi 不识别该等级；保留会导致保存被拒绝">
          <span className="pi-level-name">{key} <em>（未知等级）</em></span>
          <button type="button" className="pi-level-x" aria-label={`移除未知等级 ${key}`} onClick={() => removeDropped(key)}>×</button>
        </span>
      ))}
      {adding ? (
        <span className="pi-level-edit pi-level-add">
          {addable.length === 0 && <em className="pi-level-none">全部等级已在列表</em>}
          {addable.map(level => (
            <button key={level} type="button" className="pi-level-name" onClick={() => openEditor(level)}>{level}</button>
          ))}
          <button type="button" className="pi-level-x" aria-label="取消添加" onClick={() => setAdding(false)}>×</button>
        </span>
      ) : (
        addable.length > 0 && (
          <button type="button" className="pi-level-addbtn" aria-label="添加推理等级" onClick={() => setAdding(true)}>+</button>
        )
      )}
    </div>
  );
}
