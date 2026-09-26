import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionArchive } from '../src/main/pi/session-archive';
import { assertArchivedDeletable, autoDeleteArchivedKeys, deleteArchivedSession } from '../src/main/pi/auto-delete';
import { fileKey } from '../src/main/pi/session-index';
import { DEFAULT_AUTO_DELETE_ARCHIVED_DAYS, type DesktopPreferences } from '../src/shared/settings';
import type { PiRun, PiSession } from '../src/shared/pi';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })); });
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-archive-delete-'));
  roots.push(root);
  const file = path.join(root, 'metadata', 'archived-sessions.json');
  return { root, file };
}

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const basePrefs: DesktopPreferences = { behavior: 'followUp', permission: 'ask', shortcuts: { search: 'Mod+K', newSession: 'Mod+Shift+N', settings: 'Mod+,', workbench: 'Mod+Shift+R', sidebar: 'Mod+B', stop: 'Mod+Shift+X' }, projects: [] };
const entry = (key: string, ageDays: number) => ({ key, archivedAt: NOW - ageDays * DAY });
const session = (key: string, updatedAt = NOW - 90 * DAY): PiSession => ({ key, id: key, path: `/sessions/${key}.jsonl`, cwd: '/work/a', name: key, updatedAt, size: 10, warnings: [], owned: true });
const run = (key: string, over: Partial<PiRun> = {}): PiRun => ({ key, generation: 'g', cwd: '/work/a', file: '', status: 'idle', models: [], pending: 0, ...over });

it('migrates a legacy string[] index to entries with stable archivedAt', () => {
  const { file } = setup();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(['old-with-session', 'old-without']));
  const before = Date.now();
  const archive = new SessionArchive(file, key => key === 'old-with-session' ? 1_700_000_000_000 : undefined);
  // 能从会话索引拿到 updatedAt 就用，拿不到用当前时间。
  expect(archive.entries()).toEqual([
    { key: 'old-with-session', archivedAt: 1_700_000_000_000 },
    { key: 'old-without', archivedAt: expect.any(Number) },
  ]);
  const migrated = archive.entries().find(e => e.key === 'old-without')!;
  expect(migrated.archivedAt).toBeGreaterThanOrEqual(before);
  // 迁移立即落盘新格式，且 archivedAt 稳定（再读不会变成新的 now）。
  const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
  expect(persisted).toEqual(archive.entries());
  expect(new SessionArchive(file).entries()).toEqual(archive.entries());
  // list() 对外仍是 key[]，保持兼容。
  expect(archive.list()).toEqual(['old-with-session', 'old-without']);
});

it('writes the new entry format and refreshes archivedAt on re-archive', () => {
  const { file } = setup();
  const archive = new SessionArchive(file);
  vi.useFakeTimers();
  try {
    vi.setSystemTime(1_000_000);
    archive.set('one', true);
    vi.setSystemTime(2_000_000);
    archive.set('two', true);
    archive.set('one', true); // 重新归档刷新计时
    expect(new SessionArchive(file).entries()).toEqual([
      { key: 'one', archivedAt: 2_000_000 },
      { key: 'two', archivedAt: 2_000_000 },
    ]);
    expect(archive.set('one', false)).toEqual(['two']);
    expect(new SessionArchive(file).entries()).toEqual([{ key: 'two', archivedAt: 2_000_000 }]);
  } finally {
    vi.useRealTimers();
  }
});

it('rejects a corrupted new-format index without overwriting it', () => {
  const { file } = setup();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify([{ key: 'broken' }]));
  const archive = new SessionArchive(file);
  expect(() => archive.entries()).toThrow('索引损坏');
  expect(() => archive.set('one', true)).toThrow('索引损坏');
  expect(fs.readFileSync(file, 'utf8')).toBe(JSON.stringify([{ key: 'broken' }]));
});

it('remove() clears deleted entries and keeps other archivedAt values intact', () => {
  const { file } = setup();
  const archive = new SessionArchive(file);
  archive.setMany(['a', 'b', 'c'], true);
  const stamped = archive.entries();
  expect(archive.remove(['b', 'missing'])).toEqual(['a', 'c']);
  expect(new SessionArchive(file).entries()).toEqual(stamped.filter(e => e.key !== 'b'));
  expect(() => archive.remove([''])).toThrow('归档参数无效');
});

it('auto-delete returns nothing while disabled and honors the retention cutoff', () => {
  const sessions = [session('old'), session('edge'), session('fresh')];
  const entries = [entry('old', 31), entry('edge', 30), entry('fresh', 29)];
  expect(autoDeleteArchivedKeys({ preferences: { ...basePrefs, autoDeleteArchived: false, autoDeleteArchivedDays: 7 }, entries, sessions, runs: [], now: NOW })).toEqual([]);
  expect(autoDeleteArchivedKeys({ preferences: { ...basePrefs, autoDeleteArchived: true, autoDeleteArchivedDays: 30 }, entries, sessions, runs: [], now: NOW })).toEqual(['old', 'edge']);
});

it('auto-delete never touches sessions with open runs or pending dialogs, nor entries outside the archive index', () => {
  const prefs: DesktopPreferences = { ...basePrefs, autoDeleteArchived: true, autoDeleteArchivedDays: 7 };
  const entries = [entry('free', 90), entry('open-run', 90), entry('idle-run', 90), entry('confirming', 90), entry('missing-file', 90)];
  const sessions = [session('free'), session('open-run'), session('idle-run'), session('confirming')];
  const runs = [run('open-run', { status: 'running' }), run('idle-run')];
  const keys = autoDeleteArchivedKeys({ preferences: prefs, entries, sessions, runs, hasPendingDialogs: key => key === 'confirming', now: NOW });
  expect(keys).toEqual(['free']); // missing-file 在索引中找不到会话文件，不进入候选
  // 未归档会话不可能被选中：候选只来自归档 entries。
  const stray = autoDeleteArchivedKeys({ preferences: prefs, entries: [], sessions: [session('never-archived')], runs: [], now: NOW });
  expect(stray).toEqual([]);
});

it('recent activity after archiving resets the inactivity window', () => {
  const prefs: DesktopPreferences = { ...basePrefs, autoDeleteArchived: true, autoDeleteArchivedDays: 30 };
  expect(autoDeleteArchivedKeys({ preferences: prefs, entries: [entry('recent', 90), entry('old', 90)], sessions: [session('recent', NOW - 2 * DAY), session('old')], runs: [], now: NOW })).toEqual(['old']);
});

it('auto-delete falls back to the default retention for invalid values', () => {
  const prefs = { ...basePrefs, autoDeleteArchived: true, autoDeleteArchivedDays: 45 } as DesktopPreferences;
  const sessions = [session('a'), session('b')];
  const entries = [entry('a', DEFAULT_AUTO_DELETE_ARCHIVED_DAYS + 0.5), entry('b', 8)];
  expect(autoDeleteArchivedKeys({ preferences: prefs, entries, sessions, runs: [], now: NOW })).toEqual(['a']);
});

it('manual deletion trashes only indexed archived JSONL files and removes the archive entry', async () => {
  const { root, file } = setup();
  const sessionPath = path.join(root, 'one.jsonl');
  fs.writeFileSync(sessionPath, 'native session content');
  const key = fileKey(sessionPath), archive = new SessionArchive(file);
  archive.set(key, true);
  const trash = vi.fn(async (target: string) => { fs.renameSync(target, target + '.trashed'); });
  const input = { key, archive, sessions: [{ ...session('one'), key, path: sessionPath }], runs: [],
    hasPendingDialogs: () => false, trash, exists: fs.existsSync, keyOf: fileKey };
  await expect(deleteArchivedSession({ ...input, key: 'not-archived' })).rejects.toThrow('不在归档列表');
  expect(trash).not.toHaveBeenCalled();
  await expect(deleteArchivedSession({ ...input, runs: [run(key)] })).rejects.toThrow('停止任务');
  expect(fs.existsSync(sessionPath)).toBe(true);
  expect(await deleteArchivedSession(input)).toEqual([]);
  expect(trash).toHaveBeenCalledWith(sessionPath);
  expect(fs.readFileSync(sessionPath + '.trashed', 'utf8')).toBe('native session content');
  expect(archive.list()).toEqual([]);
});

it('manual deletion retains the archive index when Trash fails; missing file cleans the entry', async () => {
  const { root, file } = setup();
  const sessionPath = path.join(root, 'one.jsonl');
  fs.writeFileSync(sessionPath, 'native session content');
  const key = fileKey(sessionPath), archive = new SessionArchive(file);
  archive.set(key, true);
  const input = { key, archive, sessions: [{ ...session('one'), key, path: sessionPath }], runs: [],
    hasPendingDialogs: () => false, exists: fs.existsSync, keyOf: fileKey };
  await expect(deleteArchivedSession({ ...input, trash: async () => { throw new Error('Trash unavailable'); } })).rejects.toThrow('Trash unavailable');
  expect(archive.list()).toEqual([key]);
  fs.unlinkSync(sessionPath);
  const trash = vi.fn(async () => {});
  await expect(deleteArchivedSession({ ...input, trash })).resolves.toEqual([]);
  expect(trash).not.toHaveBeenCalled();
});

it('manual delete guard requires an archived, idle, unconfirmed session', () => {
  expect(() => assertArchivedDeletable({ key: 'nope', archived: ['a'], runs: [] })).toThrow('不在归档列表');
  expect(() => assertArchivedDeletable({ key: '', archived: ['a'], runs: [] })).toThrow('标识无效');
  expect(() => assertArchivedDeletable({ key: 'a', archived: ['a'], runs: [run('a')] })).toThrow('停止任务');
  expect(() => assertArchivedDeletable({ key: 'a', archived: ['a'], runs: [], hasPendingDialogs: () => true })).toThrow('停止任务');
  expect(() => assertArchivedDeletable({ key: 'a', archived: ['a'], runs: [], hasPendingDialogs: () => false })).not.toThrow();
});
