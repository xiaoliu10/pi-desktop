import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RemoteVisibility, type VisibilitySource } from '../src/main/pi/remote-visibility';
import type { PiRun, PiSession } from '../src/shared/pi';

function session(overrides: Partial<PiSession> & { key: string; cwd: string }): PiSession {
  return { id: overrides.key, path: `/tmp/${overrides.key}.jsonl`, name: overrides.key, updatedAt: 1, size: 1, warnings: [], owned: false, ...overrides };
}

function run(overrides: Partial<PiRun> & { key: string; cwd: string }): PiRun {
  return { generation: 'g', file: `/tmp/${overrides.key}.jsonl`, status: 'running', models: [], commands: [], pending: 0, ...overrides } as PiRun;
}

function source(overrides: Partial<VisibilitySource> & { sessions: VisibilitySource['sessions'] }): VisibilitySource {
  return { runs: () => [], ...overrides };
}

describe('RemoteVisibility (mobile visibility = desktop sidebar)', () => {
  it('filters archived sessions, hidden projects, subagent-internal and sidecar sessions', () => {
    const visibility = new RemoteVisibility(source({
      sessions: () => [
        session({ key: 'k-live', cwd: '/proj' }),
        session({ key: 'k-arch', cwd: '/proj' }),
        session({ key: 'k-hidden', cwd: '/gone' }),
        session({ key: 'k-sub', cwd: '/proj', parentSession: '/proj/a.jsonl' }),
        session({ key: 'k-side', cwd: '/proj', sidecarOf: '' }),
      ],
      archivedSessions: () => ['k-arch'],
      hiddenProjects: () => ['/gone'],
    }));
    const snap = visibility.snapshot(true);
    expect(snap.sessionVisible(session({ key: 'k-live', cwd: '/proj' }))).toBe(true);
    expect(snap.sessionVisible(session({ key: 'k-arch', cwd: '/proj' }))).toBe(false);
    expect(snap.sessionVisible(session({ key: 'k-hidden', cwd: '/gone' }))).toBe(false);
    expect(snap.sessionVisible(session({ key: 'k-sub', cwd: '/proj', parentSession: '/x.jsonl' }))).toBe(false);
    expect(snap.sessionVisible(session({ key: 'k-side', cwd: '/proj', sidecarOf: '' }))).toBe(false);
  });

  it('matches hidden projects recorded under a symlink alias (canonical cwd, both directions)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-vis-'));
    try {
      const realDir = path.join(root, 'realproj');
      const aliasDir = path.join(root, 'aliasproj');
      fs.mkdirSync(realDir);
      fs.symlinkSync(realDir, aliasDir, 'dir');
      // 偏好里记的是别名（旧版从别名目录添加），会话头里是真实路径。
      const byAlias = new RemoteVisibility(source({
        sessions: () => [session({ key: 'k-real', cwd: realDir })],
        hiddenProjects: () => [aliasDir],
      }));
      expect(byAlias.snapshot(true).sessionVisible(session({ key: 'k-real', cwd: realDir }))).toBe(false);
      // 反向：偏好记真实路径，会话从别名目录启动。
      const byReal = new RemoteVisibility(source({
        sessions: () => [session({ key: 'k-alias', cwd: aliasDir })],
        hiddenProjects: () => [realDir],
      }));
      expect(byReal.snapshot(true).sessionVisible(session({ key: 'k-alias', cwd: aliasDir }))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('degrades per-input: corrupt archive index or throwing preferences never filter, never throw', () => {
    const base = source({ sessions: () => [session({ key: 'k1', cwd: '/proj' })] });
    expect(new RemoteVisibility({ ...base, archivedSessions: () => { throw new Error('归档索引损坏'); } }).snapshot(true).sessionVisible(session({ key: 'k1', cwd: '/proj' }))).toBe(true);
    expect(new RemoteVisibility({ ...base, hiddenProjects: () => { throw new Error('偏好损坏'); } }).snapshot(true).sessionVisible(session({ key: 'k1', cwd: '/proj' }))).toBe(true);
    expect(new RemoteVisibility({ ...base, archivedSessions: () => { throw new Error('x'); }, hiddenProjects: () => ['/proj'] }).snapshot(true).sessionVisible(session({ key: 'k1', cwd: '/proj' }))).toBe(false);
  });

  it('reflects dynamic preferences on each forced snapshot (state path is never stale)', () => {
    let hidden: string[] = [];
    const visibility = new RemoteVisibility(source({
      sessions: () => [session({ key: 'k1', cwd: '/proj' })],
      hiddenProjects: () => hidden,
    }));
    expect(visibility.snapshot(true).sessionVisible(session({ key: 'k1', cwd: '/proj' }))).toBe(true);
    hidden = ['/proj'];
    expect(visibility.snapshot(true).sessionVisible(session({ key: 'k1', cwd: '/proj' }))).toBe(false);
    hidden = [];
    expect(visibility.snapshot(true).sessionVisible(session({ key: 'k1', cwd: '/proj' }))).toBe(true);
  });

  it('caches within the TTL for event filtering; invalidate() and ttl 0 force fresh reads', () => {
    let calls = 0;
    const visibility = new RemoteVisibility(source({
      sessions: () => { calls += 1; return [session({ key: 'k1', cwd: '/proj' })]; },
      hiddenProjects: () => ['/proj'],
    }), 60_000);
    visibility.snapshot(); visibility.snapshot();
    expect(calls).toBe(1); // TTL 内复用
    visibility.invalidate();
    visibility.snapshot();
    expect(calls).toBe(2);
    const eager = new RemoteVisibility(source({
      sessions: () => { calls += 1; return []; },
    }), 0);
    eager.snapshot(); eager.snapshot();
    expect(calls).toBe(4); // ttl=0 每次现算（等价 /api/state 的 force 口径）
  });

  it('judges key-only events via sessions first, then active runs, and passes unknown keys', () => {
    const visibility = new RemoteVisibility(source({
      sessions: () => [session({ key: 'k-hid', cwd: '/gone' })],
      runs: () => [run({ key: 'k-run-only', cwd: '/also-gone' })],
      hiddenProjects: () => ['/gone', '/also-gone'],
      archivedSessions: () => ['k-arch'],
    }));
    const snap = visibility.snapshot(true);
    expect(snap.keyVisible('k-hid')).toBe(false); // 会话口径
    expect(snap.keyVisible('k-run-only')).toBe(false); // 未落盘，退回 run.cwd
    expect(snap.keyVisible('k-arch')).toBe(false);
    expect(snap.keyVisible('k-unknown')).toBe(true); // 不误杀未知 key
    expect(snap.keyVisible(undefined)).toBe(true);
  });

  it('runVisible filters sidecar runs, archived keys, hidden cwd (including alias) and internal sessions', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-vis-run-'));
    try {
      const realDir = path.join(root, 'proj');
      const aliasDir = path.join(root, 'alias');
      fs.mkdirSync(realDir);
      fs.symlinkSync(realDir, aliasDir, 'dir');
      const visibility = new RemoteVisibility(source({
        sessions: () => [session({ key: 'k-sub', cwd: realDir, parentSession: '/x.jsonl' })],
        runs: () => [],
        archivedSessions: () => ['k-arch'],
        hiddenProjects: () => [aliasDir], // 偏好记别名
      }));
      const snap = visibility.snapshot(true);
      expect(snap.runVisible(run({ key: 'k-ok', cwd: realDir }))).toBe(false); // cwd 别名归一化后命中隐藏
      expect(snap.runVisible(run({ key: 'k-arch', cwd: realDir }))).toBe(false);
      expect(snap.runVisible({ key: 'k-side', cwd: realDir, sidecarOf: 'k-main' })).toBe(false);
      expect(snap.runVisible(run({ key: 'k-sub', cwd: realDir }))).toBe(false); // 落盘后按会话口径补判
      expect(snap.runVisible(run({ key: 'k-live', cwd: path.join(root, 'other') }))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
