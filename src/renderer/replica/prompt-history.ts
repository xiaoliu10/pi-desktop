// 输入框 ↑/↓ 发送历史（复刻 ZCode promptHistory + promptHistoryStorage）：
// - 按 workspace 隔离、localStorage 持久化（重启后仍可 recall），最多 30 条；
// - 连续重复只留一条（只比较最后一条，避免误删 A、B、A 非连续重复）；
// - up: 未进入历史态 → 最新一条，否则向更旧；到最旧停在 0；
// - down: 未进入历史态 → 最新一条；已在最新一条 → 退出历史态、恢复空草稿。

export const MAX_PROMPT_HISTORY = 30;

const STORAGE_KEY_PREFIX = 'pi-desktop-chat-prompt-history:';

type PromptHistoryDirection = 'up' | 'down';

export interface PromptHistoryNavigationResult {
  nextIndex: number | null;
  nextValue: string;
  shouldHandle: boolean;
}

function normalizeEntries(entries: readonly unknown[]): string[] {
  return entries
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .slice(-MAX_PROMPT_HISTORY);
}

function storageKey(cwd: string) {
  return `${STORAGE_KEY_PREFIX}${cwd}`;
}

function getBrowserStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try { return window.localStorage; } catch { return null; }
}

export function readPromptHistory(cwd: string, storage: Storage | null = getBrowserStorage()): string[] {
  const raw = storage?.getItem(storageKey(cwd));
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return normalizeEntries(parsed);
  } catch {
    return [];
  }
}

export function persistPromptHistory(cwd: string, entries: readonly string[], storage: Storage | null = getBrowserStorage()) {
  storage?.setItem(storageKey(cwd), JSON.stringify(normalizeEntries(entries)));
}

export function appendPromptHistoryEntry(entries: readonly string[], entry: string, limit = MAX_PROMPT_HISTORY): string[] {
  const trimmed = entry.trim();
  if (!trimmed) return [...entries];
  if (entries.at(-1)?.trim() === trimmed) return [...entries];
  const normalizedLimit = Math.max(1, Math.trunc(limit));
  return [...entries, trimmed].slice(-normalizedLimit);
}

export function navigatePromptHistory(
  entries: readonly string[],
  currentIndex: number | null,
  direction: PromptHistoryDirection,
): PromptHistoryNavigationResult {
  if (entries.length === 0) {
    return { nextIndex: currentIndex, nextValue: '', shouldHandle: false };
  }
  if (direction === 'up') {
    const nextIndex = currentIndex === null ? entries.length - 1 : Math.max(currentIndex - 1, 0);
    return { nextIndex, nextValue: entries[nextIndex] ?? '', shouldHandle: true };
  }
  if (currentIndex === null) {
    const nextIndex = entries.length - 1;
    return { nextIndex, nextValue: entries[nextIndex] ?? '', shouldHandle: true };
  }
  if (currentIndex >= entries.length - 1) {
    return { nextIndex: null, nextValue: '', shouldHandle: true };
  }
  const nextIndex = currentIndex + 1;
  return { nextIndex, nextValue: entries[nextIndex] ?? '', shouldHandle: true };
}
