import {
  appendPromptHistoryEntry, persistPromptHistory, readPromptHistory,
  type PromptHistoryEntry, type PromptHistoryEntryInput,
} from './prompt-history';

// Large image payloads do not fit localStorage. Keep complete workspace histories
// in memory for synchronous switches and in IndexedDB for reloads/restarts.
const histories = new Map<string, PromptHistoryEntry[]>();
const revisions = new Map<string, number>();
const HISTORY_WORKSPACES = 20;
const HISTORY_BUDGET = 40 * 1024 * 1024;
const entrySize = (entry: PromptHistoryEntry) => entry.text.length + entry.items.reduce((n, item) => n + item.text.length + (item.image?.data.length ?? 0), 0);
function retainWorkspaceHistory() {
  while (histories.size > HISTORY_WORKSPACES
    || [...histories.values()].reduce((n, entries) => n + entries.reduce((m, entry) => m + entrySize(entry), 0), 0) > HISTORY_BUDGET && histories.size > 1) {
    const oldest = histories.keys().next().value;
    if (oldest === undefined) break;
    histories.delete(oldest);
  }
}
let database: Promise<IDBDatabase | null> | undefined;
const writes = new Map<string, Promise<void>>();

function openHistoryDatabase(): Promise<IDBDatabase | null> {
  if (database) return database;
  database = new Promise(resolve => {
    if (typeof indexedDB === 'undefined') { resolve(null); return; }
    try {
      const request = indexedDB.open('pi-desktop-prompt-history', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('workspaces');
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
      request.onsuccess = () => {
        request.result.onversionchange = () => { request.result.close(); database = undefined; };
        resolve(request.result);
      };
    } catch { resolve(null); }
  });
  return database;
}

export function workspacePromptHistory(cwd: string): PromptHistoryEntry[] {
  if (!histories.has(cwd)) {
    histories.set(cwd, readPromptHistory(cwd));
    retainWorkspaceHistory();
  }
  return histories.get(cwd)!;
}

/** Late hydration must not replace an entry submitted since loading began. */
export async function loadWorkspacePromptHistory(cwd: string): Promise<PromptHistoryEntry[]> {
  const initial = workspacePromptHistory(cwd);
  const revision = revisions.get(cwd) ?? 0;
  // Memory already contains every entry from this run, even if disk writes failed.
  if (revision > 0) return initial;
  const db = await openHistoryDatabase();
  if (!db) return workspacePromptHistory(cwd);
  try {
    const raw = await new Promise<unknown>((resolve, reject) => {
      const request = db.transaction('workspaces').objectStore('workspaces').get(cwd);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if ((revisions.get(cwd) ?? 0) === revision && Array.isArray(raw)) {
      // Use the existing validated reader for both legacy and rich entries.
      const storage = { getItem: () => JSON.stringify(raw) } as unknown as Storage;
      histories.set(cwd, readPromptHistory(cwd, storage));
    }
  } catch { /* Keep the full memory history or legacy localStorage data. */ }
  return workspacePromptHistory(cwd);
}

export function recordWorkspacePrompt(cwd: string, entry: PromptHistoryEntryInput): PromptHistoryEntry[] {
  const next = appendPromptHistoryEntry(workspacePromptHistory(cwd), entry);
  if (next === workspacePromptHistory(cwd)) return next; // Deduplicated write: keep revision/load protocol untouched.
  histories.delete(cwd);
  histories.set(cwd, next);
  retainWorkspaceHistory();
  revisions.set(cwd, (revisions.get(cwd) ?? 0) + 1);
  // Maintain backwards-compatible storage when it fits; a quota error is harmless.
  persistPromptHistory(cwd, next);
  // Serialize writes so an older asynchronous snapshot cannot overwrite a new one.
  const write = (writes.get(cwd) ?? Promise.resolve()).then(async () => {
    const db = await openHistoryDatabase();
    if (!db) return;
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('workspaces', 'readwrite');
      transaction.objectStore('workspaces').put(next, cwd);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }).catch(() => { /* Disk quota/security failure must not block sending. */ });
  writes.set(cwd, write);
  void write.finally(() => { if (writes.get(cwd) === write) writes.delete(cwd); });
  return next;
}
