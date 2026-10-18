import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionIndex } from '../src/main/pi/session-index';

function makeSession(dir: string, count: number): { file: string; ids: string[] } {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'paged.jsonl');
  const ids: string[] = [];
  const lines: string[] = [JSON.stringify({ type: 'session', version: 3, id: 's1', cwd: dir })];
  let parent: string | null = null;
  for (let i = 0; i < count; i += 1) {
    const id = `m${i}`;
    ids.push(id);
    const role = i % 2 === 0 ? 'user' : 'assistant';
    lines.push(JSON.stringify({ type: 'message', id, parentId: parent, message: { role, content: [{ type: 'text', text: `t${i}` }] } }));
    parent = id;
  }
  writeFileSync(file, lines.join('\n') + '\n');
  return { file, ids };
}

describe('history paging (tail / before)', () => {
  it('returns only the tail window and reports what was withheld', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hist-page-'));
    try {
      const { ids } = makeSession(dir, 1000);
      const index = new SessionIndex([dir], dir);
      const key = index.scan()[0].key;
      const whole = index.history(key);
      expect(whole.branch.length).toBe(1000);
      const tail = index.history(key, undefined, { tail: 100 });
      expect(tail.branch.length).toBe(100);
      expect(tail.truncated).toEqual({ total: 1000, returned: 100 });
      expect(tail.branch.at(-1)!.id).toBe(ids.at(-1));
      // IPC 瘦身（wireLite）：分页模式下 entries 用 branch 顶替——renderer 对
      // entries 零消费，全量 entries 过 IPC 是打字尖峰的最后根因（17609 条的
      // 序列化/反序列化各 ~500ms）。游标只需要 branch 的 id，不需要 entries。
      expect(tail.entries.length).toBe(100);
      expect(tail.entries).toBe(tail.branch); // 同一引用：瘦身是替身不是拷贝
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('before paging prepends the requested page and keeps the tail', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hist-page2-'));
    try {
      const { ids } = makeSession(dir, 1000);
      const index = new SessionIndex([dir], dir);
      const key = index.scan()[0].key;
      const first = index.history(key, undefined, { tail: 100 });
      expect(first.branch[0]!.id).toBe(ids[900]);
      // 从首屏第一条之前再拉 50 条：应得到 ids[850..900) + 尾部 100 条
      const second = index.history(key, undefined, { before: first.branch[0]!.id, count: 50 });
      expect(second.branch.length).toBe(150);
      expect(second.branch[0]!.id).toBe(ids[850]);
      expect(second.branch.at(-1)!.id).toBe(ids[999]);
      // 无重叠、顺序严格递增
      const positions = second.branch.map(e => Number(e.id.slice(1)));
      for (let i = 1; i < positions.length; i += 1) expect(positions[i]).toBeGreaterThan(positions[i - 1]!);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('tail larger than the branch is a no-op (no truncated field)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hist-page3-'));
    try {
      makeSession(dir, 10);
      const index = new SessionIndex([dir], dir);
      const key = index.scan()[0].key;
      const out = index.history(key, undefined, { tail: 5000 });
      expect(out.branch.length).toBe(10);
      expect(out.truncated).toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
