/**
 * 前进/后退导航历史（复刻 ZCode taskNavigationHistory 的浏览器式语义）：
 * entries + cursor 双栈合一，push 时截断 cursor 之后的前进分支、相邻去重，
 * 上限 50 条。纯数据结构 + 不可变更新，store 持有实例并驱动 UI。
 *
 * 目标 = 视图（home/chat/plugins/settings/automations）+ 会话 key（chat 专属）。
 */

export type NavView = 'home' | 'chat' | 'plugins' | 'settings' | 'automations';

export interface NavEntry {
  view: NavView;
  /** chat 视图的会话 key；其余视图为空。 */
  key?: string;
}

export interface NavHistory {
  entries: NavEntry[];
  /** 当前指针；-1 表示空。 */
  cursor: number;
}

export const NAV_HISTORY_LIMIT = 50;

export function createNavHistory(): NavHistory {
  return { entries: [], cursor: -1 };
}

function isSameEntry(left: NavEntry, right: NavEntry): boolean {
  return left.view === right.view && (left.key ?? null) === (right.key ?? null);
}

/** 用户主动切换视图/会话时入栈；相邻重复不入栈，前进分支被截断。 */
export function pushNavEntry(history: NavHistory, entry: NavEntry): NavHistory {
  const current = history.cursor >= 0 ? history.entries[history.cursor] : undefined;
  if (current && isSameEntry(current, entry)) return history;
  const next = [...history.entries.slice(0, history.cursor + 1), entry];
  if (next.length > NAV_HISTORY_LIMIT) {
    const overflow = next.length - NAV_HISTORY_LIMIT;
    return { entries: next.slice(overflow), cursor: next.length - overflow - 1 };
  }
  return { entries: next, cursor: next.length - 1 };
}

export function canGoBack(history: NavHistory): boolean {
  return history.cursor > 0;
}

export function canGoForward(history: NavHistory): boolean {
  return history.cursor >= 0 && history.cursor < history.entries.length - 1;
}

export function navBack(history: NavHistory): { history: NavHistory; entry: NavEntry } | null {
  if (!canGoBack(history)) return null;
  const cursor = history.cursor - 1;
  const entry = history.entries[cursor];
  return entry ? { history: { ...history, cursor }, entry } : null;
}

export function navForward(history: NavHistory): { history: NavHistory; entry: NavEntry } | null {
  if (!canGoForward(history)) return null;
  const cursor = history.cursor + 1;
  const entry = history.entries[cursor];
  return entry ? { history: { ...history, cursor }, entry } : null;
}

/**
 * 会话被删除时从历史中移除它的所有条目（ZCode removeTaskFromHistory 同义）。
 * 其余视图的条目不属于会话生命周期，原样保留。
 */
export function removeSessionFromNavHistory(history: NavHistory, key: string): NavHistory {
  const filtered = history.entries.filter((entry) => entry.view !== 'chat' || entry.key !== key);
  if (filtered.length === history.entries.length) return history;
  if (filtered.length === 0) return createNavHistory();
  // 移除的条目都在 cursor 之后时 cursor 不动；否则 cursor 前移被删数量。
  const removedBefore = history.entries.slice(0, history.cursor + 1).filter((entry) => entry.view === 'chat' && entry.key === key).length;
  const cursor = Math.min(history.cursor - removedBefore, filtered.length - 1);
  return { entries: filtered, cursor };
}
