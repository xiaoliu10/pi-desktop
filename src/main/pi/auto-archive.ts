import { canonical } from './session-index';
import { ARCHIVE_RETENTION_DAYS, DEFAULT_ARCHIVE_RETENTION_DAYS, type DesktopPreferences } from '../../shared/settings';
import type { PiRun, PiSession } from '../../shared/pi';

/**
 * 自动归档候选筛选：任务最后更新时间早于保留时长、所属项目未置顶，
 * 且当前没有打开的连接（运行中 / 排队 / 等待确认的会话一律跳过）。
 */
export function autoArchiveKeys(input: {
  preferences: DesktopPreferences;
  sessions: PiSession[];
  runs: PiRun[];
  hasPendingDialogs?: (key: string) => boolean;
  now?: number;
}): string[] {
  if (!input.preferences.autoArchive) return [];
  const days = (ARCHIVE_RETENTION_DAYS as readonly number[]).includes(input.preferences.archiveRetentionDays ?? DEFAULT_ARCHIVE_RETENTION_DAYS)
    ? input.preferences.archiveRetentionDays ?? DEFAULT_ARCHIVE_RETENTION_DAYS
    : DEFAULT_ARCHIVE_RETENTION_DAYS;
  const cutoff = (input.now ?? Date.now()) - days * 86_400_000;
  const pinned = new Set((input.preferences.projects ?? []).filter(p => p.pinned).map(p => canonical(p.path)));
  const busy = new Set(input.runs.filter(r => r.status !== 'idle' || r.pending > 0 || input.hasPendingDialogs?.(r.key)).map(r => r.key));
  return input.sessions
    .filter(s => s.updatedAt <= cutoff)
    .filter(s => !pinned.has(canonical(s.cwd)))
    .filter(s => !input.runs.some(r => r.key === s.key))
    .filter(s => !busy.has(s.key))
    .map(s => s.key);
}
