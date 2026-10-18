import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionIndex } from '../src/main/pi/session-index';

// 埋点报告（2026-10-18 真实会话）锁定的第一根因：history-ipc 33 次共 17.6s 阻塞
// （p50=543ms）——每次 history() 都从全量 entries 回溯 branch（建 Map + 链回溯），
// 而流式期间每 150ms 一拍都调 history()，主进程阻塞全落在打字的长帧里
// （text-input delay 最大 7322ms）。
// 修法：branchMemo 按 (entries 引用, leaf) 复用。真实 205MB 会话实测 5.7ms → 0.42ms。
// 本条用合成大会话钉住契约（CI 不依赖用户本地数据）。
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bm-'));

function bigSession(dir: string, n: number): void {
  const entries: any[] = [{ type: 'session', version: 3, id: 's', cwd: dir }];
  let parent: string | null = null;
  for (let i = 0; i < n; i += 1) {
    const id = `u${i}`;
    entries.push({ type: 'message', id, parentId: parent, timestamp: '2026-10-18T00:00:00Z', message: { role: 'user', content: [{ type: 'text', text: `第 ${i} 轮：打字卡顿治理` }] } });
    const a = `a${i}`;
    entries.push({ type: 'message', id: a, parentId: id, timestamp: '2026-10-18T00:00:01Z', message: { role: 'assistant', content: [{ type: 'text', text: `回复 ${i}` }] } });
    parent = a;
  }
  fs.writeFileSync(path.join(dir, 's.jsonl'), entries.map(e => JSON.stringify(e)).join('\n') + '\n');
}

describe('branch memo (history() hot path)', () => {
  it('repeat history() with the same leaf reuses the branch array', () => {
    const dir = temp();
    bigSession(dir, 3000); // 6000 entries
    const index = new SessionIndex([dir], dir);
    const key = index.scan()[0].key;
    const first = index.history(key);
    const leaf = first.leafId!;
    const cold = index.history(key, leaf);
    const warm = index.history(key, leaf);
    // 同一引用 = 真的复用了（不是重建后恰好相等）
    expect(warm.branch).toBe(cold.branch);
    expect(warm.branch.length).toBe(6000);
  });

  it('memo invalidates when entries change (incremental parse)', async () => {
    const dir = temp();
    bigSession(dir, 10);
    const file = path.join(dir, 's.jsonl');
    const index = new SessionIndex([dir], dir);
    const key = index.scan()[0].key;
    const leaf = index.history(key).leafId!;
    const before = index.history(key, leaf);
    // 追加新 entry（模拟流式增量）
    // sleep 5ms：stamp 含 mtimeMs——同一毫秒内 append 会让 stamp 与缓存相同而走
    // 「未变」快路径（流式每拍 150ms，线上不会撞上；测试必须显式错开）。
    await new Promise(r => setTimeout(r, 5));
    fs.appendFileSync(file, JSON.stringify({ type: 'message', id: 'new-1', parentId: leaf, timestamp: '2026-10-18T00:00:09Z', message: { role: 'user', content: [{ type: 'text', text: '新增一轮' }] } }) + '\n');
    const after = index.history(key, 'new-1');
    expect(after.branch.length).toBe(before.branch.length + 1);
    // 旧 leaf 的 branch 内容不变（new-1 是 leaf 的子节点，不进 leaf 的祖先链），
    // 但 entries 引用已更新 → memo 失效重建一次；此后同 leaf 重复读又复用同一引用。
    const sameLeafAgain = index.history(key, leaf);
    expect(sameLeafAgain.branch.length).toBe(before.branch.length);
    expect(sameLeafAgain.branch.at(-1)!.id).toBe(leaf);
    expect(index.history(key, leaf).branch).toBe(sameLeafAgain.branch);
    // 新 leaf 的槽与旧 leaf 互不顶掉（per-leaf memo）
    expect(index.history(key, 'new-1').branch).toBe(after.branch);
  });

  it('tail/before paging still works through the memo', () => {
    const dir = temp();
    bigSession(dir, 20);
    const index = new SessionIndex([dir], dir);
    const key = index.scan()[0].key;
    const leaf = index.history(key).leafId!;
    const tail = index.history(key, leaf, { tail: 10 });
    expect(tail.truncated).toEqual({ total: 40, returned: 10 });
    const oldest = tail.branch[0]!.id!;
    const paged = index.history(key, leaf, { before: oldest, count: 10 });
    // 语义：[before 之前 10 条] + [before 起的全部尾部 10 条] = 20，无重叠
    expect(paged.branch.length).toBe(20);
    expect(paged.branch.at(-1)!.id).toBe(leaf);
    expect(paged.truncated?.total).toBe(40); // 盘上总数，用于按钮显示真实剩余
  });
});
