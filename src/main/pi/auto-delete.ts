import { AUTO_DELETE_ARCHIVED_DAYS, DEFAULT_AUTO_DELETE_ARCHIVED_DAYS, type DesktopPreferences } from '../../shared/settings';
import type { PiRun, PiSession } from '../../shared/pi';
import type { ArchivedEntry, SessionArchive } from './session-archive';
import type { fileKey } from './session-index';

/**
 * 自动删除超期归档会话的候选筛选：归档时间早于保留时长才入选。
 * 安全边界（与 autoArchiveKeys 同一套 busy 过滤思路，且更严）：
 * - 只在归档索引（entries）内挑候选，未归档会话永远不会被这套逻辑碰到；
 * - 任何还开着连接的 run（不看 status/pending）都保护该会话；
 * - 有待确认对话框的会话一律跳过。
 */
export function autoDeleteArchivedKeys(input: {
  preferences: DesktopPreferences;
  entries: ArchivedEntry[];
  sessions: PiSession[];
  runs: PiRun[];
  hasPendingDialogs?: (key: string) => boolean;
  now?: number;
}): string[] {
  if (!input.preferences.autoDeleteArchived) return [];
  const days = (AUTO_DELETE_ARCHIVED_DAYS as readonly number[]).includes(input.preferences.autoDeleteArchivedDays ?? DEFAULT_AUTO_DELETE_ARCHIVED_DAYS)
    ? input.preferences.autoDeleteArchivedDays ?? DEFAULT_AUTO_DELETE_ARCHIVED_DAYS
    : DEFAULT_AUTO_DELETE_ARCHIVED_DAYS;
  const cutoff = (input.now ?? Date.now()) - days * 86_400_000;
  const sessions = new Map(input.sessions.map(session => [session.key, session]));
  const protectedKeys = new Set(input.runs.map(run => run.key));
  return input.entries
    // 只有归档索引内、当前仍被 session index 发现的文件才可能被删除。
    .filter(entry => {
      const session = sessions.get(entry.key);
      // updatedAt 代表归档后再次通过 CLI 等方式操作文件：以更晚的一次操作为准。
      return session && Math.max(entry.archivedAt, session.updatedAt) <= cutoff;
    })
    .filter(entry => !protectedKeys.has(entry.key))
    .filter(entry => !input.hasPendingDialogs?.(entry.key))
    .map(entry => entry.key);
}

/**
 * 手动删除归档会话的前置校验（主进程 IPC 与测试共用）：
 * key 必须在归档索引中、且没有打开的连接或待确认对话框，否则拒绝。
 */
export function assertArchivedDeletable(input: {
  key: unknown;
  archived: string[];
  runs: PiRun[];
  hasPendingDialogs?: (key: string) => boolean;
}): asserts input is { key: string } & typeof input {
  if (typeof input.key !== 'string' || !input.key || input.key.length > 512) throw new Error('会话标识无效');
  if (!input.archived.includes(input.key)) throw new Error('会话不在归档列表中，不能删除。');
  if (input.runs.some(run => run.key === input.key) || input.hasPendingDialogs?.(input.key as string)) {
    throw new Error('任务仍有打开的连接或等待确认，请先停止任务再删除。');
  }
}

/** 校验、移到废纸篓、清索引；只有文件已经移走或确实不存在时才清索引。 */
export async function deleteArchivedSession(input: {
  key: unknown;
  archive: SessionArchive;
  sessions: PiSession[];
  runs: PiRun[];
  hasPendingDialogs: (key: string) => boolean;
  trash: (file: string) => Promise<void>;
  exists: (file: string) => boolean;
  keyOf: typeof fileKey;
}): Promise<string[]> {
  const { archive, sessions, runs, hasPendingDialogs, trash, exists, keyOf } = input;
  assertArchivedDeletable({ key: input.key, archived: archive.list(), runs, hasPendingDialogs });
  const key = input.key as string;
  const session = sessions.find(s => s.key === key);
  if (session) {
    if (!session.path.endsWith('.jsonl') || keyOf(session.path) !== key) throw new Error('会话文件路径校验失败，未删除。');
    if (exists(session.path)) {
      try { await trash(session.path); }
      catch (error) {
        // 文件在扫描之后被外部程序移走：视为已删除，仍清理陈旧索引。
        // Electron trashItem 的异常不保证带有 Node 风格的 ENOENT code。
        if (exists(session.path)) throw error;
      }
    }
  }
  return archive.remove([key]);
}
