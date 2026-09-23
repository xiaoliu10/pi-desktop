import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeUsageStats } from '../src/main/pi/usage-stats';
import type { PiSession } from '../src/shared/pi';

function session(dir: string, name: string, cwd: string, lines: unknown[]): PiSession {
  const file = path.join(dir, `${name}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { key: name, id: name, path: file, cwd, name, updatedAt: 0, size: 1, warnings: [], owned: false };
}

const now = new Date('2026-09-20T12:00:00Z');

describe('usage statistics aggregator', () => {
  it('sums tokens/cost by model, day and project from assistant usage entries', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-'));
    const sessions = [
      session(dir, 's1', '/work/app', [
        { type: 'message', message: { role: 'user', content: 'hi' } },
        { type: 'message', message: { role: 'assistant', model: 'm1', provider: 'p1', timestamp: '2026-09-20T01:00:00Z', usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 0, totalTokens: 125, cost: { total: 0.01 } } } },
        { type: 'message', message: { role: 'assistant', model: 'm1', provider: 'p1', timestamp: '2026-09-20T02:00:00Z', usage: { input: 50, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 60, cost: { total: 0.02 } } } },
      ]),
      session(dir, 's2', '/work/other', [
        { type: 'message', message: { role: 'assistant', model: 'm2', provider: 'p2', timestamp: '2026-08-01T03:00:00Z', usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { total: 0.5 } } } },
        { type: 'message', message: { role: 'assistant' } }, // no usage → ignored
      ]),
      session(dir, 's3', '/work/app', []), // empty session still counts as a session
    ];
    const stats = computeUsageStats(sessions, now);
    expect(stats.sessions).toBe(3);
    expect(stats.userMessages).toBe(1);
    expect(stats.assistantMessages).toBe(3);
    expect(stats.tokens).toMatchObject({ input: 157, output: 33, cacheRead: 5, total: 195 });
    expect(stats.cost).toBeCloseTo(0.53);
    expect(stats.byModel).toHaveLength(2);
    const m1 = stats.byModel.find((m) => m.model === 'm1')!;
    expect(m1.calls).toBe(2);
    expect(m1.total).toBe(185);
    expect(m1.cost).toBeCloseTo(0.03);
    // 14-day window keeps 09-20, drops 09-10
    expect(stats.byDay.map((d) => d.day)).toEqual(['2026-09-20']);
    expect(stats.byDay[0]).toMatchObject({ tokens: 185, messages: 2 });
    expect(stats.byProject[0]).toMatchObject({ cwd: '/work/app', sessions: 2 });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('skips unreadable files without failing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-'));
    const s = session(dir, 'bad', '/x', [{ type: 'message', message: { role: 'assistant', model: 'm', provider: 'p', usage: { input: 1, output: 1, totalTokens: 2 } } }]);
    fs.chmodSync(s.path, 0o000);
    const stats = computeUsageStats([s], now);
    if (process.getuid?.() !== 0) expect(stats.assistantMessages).toBe(0);
    fs.chmodSync(s.path, 0o644);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
