import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OutlineCache } from '../src/main/pi/outline-cache';
import { SessionIndex } from '../src/main/pi/session-index';

// 用户 2026-10-18：「摘要直接做一个持久化的，每次点开对话直接加载不需要每次都重建」。
// 契约：命中条件 (size, mtimeMs, leafId) 全等；任一变化即失效重算；文件消失删条目；
// 写盘防抖 + 原子替换（tmp + rename）。
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ovl-cache-'));

function writeSession(dir: string, entries: any[]): string {
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  return file;
}

const entriesOf = (n: number) => {
  const entries: any[] = [{ type: 'session', version: 3, id: 's', cwd: '/tmp/x' }];
  let parent: string | null = null;
  for (let i = 0; i < n; i += 1) {
    entries.push({ type: 'message', id: 'u' + i, parentId: parent, timestamp: '2026-10-18T00:00:00Z', message: { role: 'user', content: [{ type: 'text', text: '第 ' + i + ' 轮' }] } });
    entries.push({ type: 'message', id: 'a' + i, parentId: 'u' + i, timestamp: '2026-10-18T00:00:01Z', message: { role: 'assistant', content: [{ type: 'text', text: 'r' }] } });
    parent = 'a' + i;
  }
  return entries;
};

describe('OutlineCache', () => {
  it('round-trips through disk and invalidates on any stamp change', () => {
    const dir = temp();
    const file = path.join(dir, 'outline-cache.json');
    const cache = new OutlineCache(file);
    const stat = { size: 100, mtimeMs: 1234 };
    cache.set('k1', stat, 'leaf-1', [{ entryId: 'u1', title: '第一轮', at: 1, toolCount: 2, hasImages: false }]);
    cache.flushNow();

    // 新实例（模拟重启后）：磁盘读回
    const reopened = new OutlineCache(file);
    expect(reopened.get('k1', stat, 'leaf-1')?.length).toBe(1);
    // size 变（会话增长）→ 失效
    expect(reopened.get('k1', { size: 200, mtimeMs: 1234 }, 'leaf-1')).toBeUndefined();
    // mtime 变（原地改写）→ 失效
    expect(reopened.get('k1', { size: 100, mtimeMs: 9999 }, 'leaf-1')).toBeUndefined();
    // leaf 变（切换分支）→ 失效
    expect(reopened.get('k1', stat, 'leaf-2')).toBeUndefined();
  });

  it('survives a corrupt cache file (treated as empty)', () => {
    const dir = temp();
    const file = path.join(dir, 'outline-cache.json');
    fs.writeFileSync(file, '{ not json');
    const cache = new OutlineCache(file);
    expect(cache.get('k1', { size: 1, mtimeMs: 1 }, undefined)).toBeUndefined();
    cache.set('k1', { size: 1, mtimeMs: 1 }, undefined, []);
    cache.flushNow();
    expect(new OutlineCache(file).get('k1', { size: 1, mtimeMs: 1 }, undefined)).toEqual([]);
  });

  it('writes atomically (tmp + rename, no torn file)', () => {
    const dir = temp();
    const file = path.join(dir, 'outline-cache.json');
    const cache = new OutlineCache(file);
    cache.set('k1', { size: 1, mtimeMs: 1 }, 'l', []);
    cache.flushNow();
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(file + '.tmp')).toBe(false); // rename 后不留 tmp
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(parsed.version).toBe(1);
    expect(Object.keys(parsed.items)).toEqual(['k1']);
  });

  it('delete removes the entry from disk', () => {
    const dir = temp();
    const file = path.join(dir, 'outline-cache.json');
    const cache = new OutlineCache(file);
    cache.set('k1', { size: 1, mtimeMs: 1 }, 'l', []);
    cache.flushNow();
    cache.delete('k1');
    cache.flushNow();
    expect(new OutlineCache(file).get('k1', { size: 1, mtimeMs: 1 }, 'l')).toBeUndefined();
  });
});

describe('SessionIndex.sessionOutline with persistent cache', () => {
  it('second call hits the cache (no re-aggregation)', () => {
    const dir = temp();
    writeSession(dir, entriesOf(5));
    const outlines = new OutlineCache(path.join(dir, 'outline-cache.json'));
    const index = new SessionIndex([dir], dir, outlines);
    const key = index.scan()[0].key;
    const first = index.sessionOutline(key); // 冷：聚合 + 写缓存
    expect(first.turns.length).toBe(5);
    const second = index.sessionOutline(key); // 热：命中缓存（同一引用 = 没重算）
    const third = index.sessionOutline(key);
    expect(second.turns).toBe(third.turns);
    expect(second.turns).not.toBe(first.turns);
  });

  it('re-aggregates and overwrites after the session grows', async () => {
    const dir = temp();
    const file = writeSession(dir, entriesOf(3));
    const outlines = new OutlineCache(path.join(dir, 'outline-cache.json'));
    const index = new SessionIndex([dir], dir, outlines);
    const key = index.scan()[0].key;
    expect(index.sessionOutline(key).turns.length).toBe(3);
    await new Promise(r => setTimeout(r, 6)); // 错开 mtimeMs（stamp 精度）
    fs.appendFileSync(file, JSON.stringify({ type: 'message', id: 'u-new', parentId: 'a2', timestamp: '2026-10-18T00:00:09Z', message: { role: 'user', content: [{ type: 'text', text: '新增一轮' }] } }) + '\n');
    const after = index.sessionOutline(key);
    expect(after.turns.length).toBe(4);
    expect(after.turns.at(-1)!.title).toBe('新增一轮');
  });

  it('caps the cached page at 500 turns but reports the true total', () => {
    const dir = temp();
    writeSession(dir, entriesOf(600));
    const outlines = new OutlineCache(path.join(dir, 'outline-cache.json'));
    const index = new SessionIndex([dir], dir, outlines);
    const key = index.scan()[0].key;
    const out = index.sessionOutline(key);
    expect(out.total).toBe(600);
    expect(out.turns.length).toBe(500); // UI 只渲染最近 500 章
    expect(out.turns.at(-1)!.title).toBe('第 599 轮');
  });
});
