// 输入框 ↑/↓ 发送历史（复刻 ZCode promptHistory + promptHistoryStorage）：
// - 按 workspace 隔离、localStorage 持久化（重启后仍可 recall），最多 30 条；
// - 连续重复只留一条（只比较最后一条，避免误删 A、B、A 非连续重复）；
// - up: 未进入历史态 → 最新一条，否则向更旧；到最旧停在 0；
// - down: 未进入历史态 → 最新一条；已在最新一条 → 退出历史态、恢复空草稿。
// 富条目：一次发送可能携带图片/文件/技能等上下文（ContextItem），recall 必须
// 原样还原（含 base64 图片数据），因此条目从纯 string 扩展为
// `{ text, items }`；旧版 string 条目照常读取（等价于 items: []）。
// 图片 base64 很容易超出 localStorage 配额：持久化失败只降级为「本条不入
// 磁盘历史」，内存里仍然完整可 recall，绝不阻断发送。

import type { ContextItem } from '../../shared/composer';

export const MAX_PROMPT_HISTORY = 30;

const STORAGE_KEY_PREFIX = 'pi-desktop-chat-prompt-history:';

type PromptHistoryDirection = 'up' | 'down';

/** A recalled prompt: visible head text plus the non-image context entries. */
export interface PromptHistoryEntry {
  text: string;
  items: Array<Omit<ContextItem, 'id'>>;
}

/** Legacy entries (plain strings) stay readable; `asEntry` normalizes both. */
export type PromptHistoryEntryInput = string | PromptHistoryEntry | { text: string; items: readonly Omit<ContextItem, 'id'>[] };

export function asEntry(value: PromptHistoryEntryInput): PromptHistoryEntry {
  return typeof value === 'string' ? { text: value, items: [] } : { text: value.text, items: [...value.items] };
}

function entryFingerprint(entry: PromptHistoryEntry): string {
  return JSON.stringify([entry.text.trim(), entry.items.map(item => [item.name, item.path, item.kind, item.text, item.image ?? null])]);
}

export interface PromptHistoryNavigationResult {
  nextIndex: number | null;
  nextValue: string;
  nextItems: PromptHistoryEntry['items'];
  shouldHandle: boolean;
}

function normalizeEntries(entries: readonly unknown[]): PromptHistoryEntry[] {
  return entries
    .map((entry) => {
      if (typeof entry === 'string') return entry.trim() ? { text: entry, items: [] } : null;
      if (!entry || typeof entry !== 'object') return null;
      const candidate = entry as Partial<PromptHistoryEntry>;
      if (typeof candidate.text !== 'string' || !candidate.text.trim()) return null;
      const items = Array.isArray(candidate.items)
        ? candidate.items.filter((item): item is PromptHistoryEntry['items'][number] => {
          if (!item || typeof item !== 'object') return false;
          const it = item as Partial<ContextItem>;
          if (typeof it.name !== 'string' || !['file', 'document', 'skill', 'image'].includes(String(it.kind))) return false;
          if (it.image !== undefined && (typeof it.image !== 'object' || it.image === null || typeof (it.image as { data?: unknown }).data !== 'string' || typeof (it.image as { mimeType?: unknown }).mimeType !== 'string')) return false;
          return true;
        })
        : [];
      return { text: candidate.text, items };
    })
    .filter((entry): entry is PromptHistoryEntry => entry !== null)
    .slice(-MAX_PROMPT_HISTORY);
}

function storageKey(cwd: string) {
  return `${STORAGE_KEY_PREFIX}${cwd}`;
}

function getBrowserStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try { return window.localStorage; } catch { return null; }
}

export function readPromptHistory(cwd: string, storage: Storage | null = getBrowserStorage()): PromptHistoryEntry[] {
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

/** Storage failures (quota with image base64, disabled storage) are swallowed:
 *  the in-memory list keeps the full entry so recall still works this run. */
export function persistPromptHistory(cwd: string, entries: readonly PromptHistoryEntryInput[], storage: Storage | null = getBrowserStorage()) {
  try {
    storage?.setItem(storageKey(cwd), JSON.stringify(normalizeEntries(entries)));
  } catch {
    // 配额超限（图片 base64 很大）：剥离图片数据重试——纯文字历史仍可落盘，
    // 带图条目保留在内存里本运行内仍可 recall；再失败（storage 被禁用）静默放弃。
    try {
      const stripped = normalizeEntries(entries).map(entry => ({
        ...entry,
        items: entry.items.map(item => (item.image ? { ...item, image: undefined } : item)),
      }));
      storage?.setItem(storageKey(cwd), JSON.stringify(stripped));
    } catch { /* keep memory-only */ }
  }
}

export function appendPromptHistoryEntry(entries: readonly PromptHistoryEntryInput[], entry: PromptHistoryEntryInput, limit = MAX_PROMPT_HISTORY): PromptHistoryEntry[] {
  const normalized = entries.map(asEntry);
  const raw = asEntry(entry);
  // 入库前去首尾空白（历史显示与比较都按 trim 后文本）；纯附件发送（空文字）仍入历史。
  const next = { text: raw.text.trim(), items: raw.items };
  if (!next.text && next.items.length === 0) return normalized;
  const normalizedLimit = Math.max(1, Math.trunc(limit));
  const previous = normalized.at(-1);
  if (previous && entryFingerprint(previous) === entryFingerprint(next)) return normalized;
  return [...normalized, next].slice(-normalizedLimit);
}

export function navigatePromptHistory(
  entries: readonly PromptHistoryEntryInput[],
  currentIndex: number | null,
  direction: PromptHistoryDirection,
): PromptHistoryNavigationResult {
  if (entries.length === 0) {
    return { nextIndex: currentIndex, nextValue: '', nextItems: [], shouldHandle: false };
  }
  const recall = (index: number): PromptHistoryNavigationResult => {
    const entry = asEntry(entries[index]!);
    return { nextIndex: index, nextValue: entry.text, nextItems: entry.items, shouldHandle: true };
  };
  if (direction === 'up') {
    return recall(currentIndex === null ? entries.length - 1 : Math.max(currentIndex - 1, 0));
  }
  if (currentIndex === null) return recall(entries.length - 1);
  if (currentIndex >= entries.length - 1) {
    return { nextIndex: null, nextValue: '', nextItems: [], shouldHandle: true };
  }
  return recall(currentIndex + 1);
}
