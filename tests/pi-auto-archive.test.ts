import { expect, it } from 'vitest';
import { autoArchiveKeys } from '../src/main/pi/auto-archive';
import { DEFAULT_ARCHIVE_RETENTION_DAYS, type DesktopPreferences } from '../src/shared/settings';
import type { PiRun, PiSession } from '../src/shared/pi';

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const basePrefs: DesktopPreferences = { behavior: 'followUp', permission: 'ask', shortcuts: { search: 'Mod+K', newSession: 'Mod+Shift+N', settings: 'Mod+,', workbench: 'Mod+Shift+R', sidebar: 'Mod+B', stop: 'Mod+Shift+X' }, projects: [] };
const session = (key: string, ageDays: number, cwd = '/work/a'): PiSession => ({ key, id: key, path: `/sessions/${key}.jsonl`, cwd, name: key, updatedAt: NOW - ageDays * DAY, size: 10, warnings: [], owned: true });
const run = (key: string, over: Partial<PiRun> = {}): PiRun => ({ key, generation: 'g', cwd: '/work/a', file: '', status: 'idle', models: [], pending: 0, ...over });

it('returns nothing when auto-archive is disabled', () => {
  expect(autoArchiveKeys({ preferences: { ...basePrefs, autoArchive: false, archiveRetentionDays: 30 }, sessions: [session('a', 90)], runs: [], now: NOW })).toEqual([]);
});

it('archives only sessions older than the retention window', () => {
  const prefs: DesktopPreferences = { ...basePrefs, autoArchive: true, archiveRetentionDays: 30 };
  const keys = autoArchiveKeys({ preferences: prefs, sessions: [session('old', 31), session('fresh', 29), session('edge', 30)], runs: [], now: NOW });
  expect(keys).toEqual(['old', 'edge']);
});

it('skips pinned projects and sessions with open or busy runs', () => {
  const prefs: DesktopPreferences = { ...basePrefs, autoArchive: true, archiveRetentionDays: 7, projects: [{ path: '/work/pinned', name: 'pinned', pinned: true }] };
  const sessions = [session('pinned', 90, '/work/pinned'), session('open', 90), session('stale', 90, '/work/other')];
  const runs = [run('open'), run('busy', { status: 'running', key: 'not-in-list' })];
  expect(autoArchiveKeys({ preferences: prefs, sessions, runs, hasPendingDialogs: () => false, now: NOW })).toEqual(['stale']);
});

it('falls back to the default retention for invalid values', () => {
  const prefs = { ...basePrefs, autoArchive: true, archiveRetentionDays: 45 } as DesktopPreferences;
  const keys = autoArchiveKeys({ preferences: prefs, sessions: [session('a', DEFAULT_ARCHIVE_RETENTION_DAYS + 0.5)], runs: [], now: NOW });
  expect(keys).toEqual(['a']);
});
