// 会话列表元数据快照（SessionMetaCache）回归：
// 冷启动先读快照秒出列表，scan() 只做 stat 指纹校验——未变文件不得重新解析全文。
// 探针手法：让快照自然写入后只篡改快照里的 name（保留 stamp），新实例若列表显示
// 篡改名 = 数据确实来自快照而非重新解析；文件真实变更后才被校正。
import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionIndex } from '../src/main/pi/session-index';
import { SessionMetaCache } from '../src/main/pi/session-meta-cache';

const roots: string[] = [];
const temp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-meta-')); roots.push(p); return p; };
afterEach(() => { roots.splice(0).forEach(p => fs.rmSync(p, { recursive: true, force: true })); });

const header = { type: 'session', version: 3, id: 's', cwd: '/p' };
const writeSession = (file: string) =>
  fs.writeFileSync(file, [
    JSON.stringify(header),
    JSON.stringify({ type: 'message', id: 'a', parentId: null, timestamp: '2026-10-21T00:00:00.000Z', message: { role: 'user', content: '真实标题' } }),
    JSON.stringify({ type: 'message', id: 'b', parentId: 'a', timestamp: '2026-10-21T00:00:01.000Z', message: { role: 'assistant', content: '答' } }),
  ].join('\n') + '\n');

it('冷启动直接从快照出列表，未变文件 scan() 不重新解析（篡改标题探针）', () => {
  const root = temp();
  const file = path.join(root, 's.jsonl');
  writeSession(file);
  const metaPath = path.join(root, 'session-meta.json');

  // 第一轮：正常冷扫并落快照
  const cache1 = new SessionMetaCache(metaPath);
  const idx1 = new SessionIndex([root], root, undefined, cache1);
  const key = idx1.scan()[0].key;
  expect(idx1.scan().find(s => s.key === key)?.name).toBe('真实标题');
  cache1.flushNow();
  expect(fs.existsSync(metaPath)).toBe(true);
  idx1.close();

  // 只篡改快照里的标题，保留 stamp（模拟「上次的列表数据」）
  const snap = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  snap.items[key].name = '快照标题X';
  fs.writeFileSync(metaPath, JSON.stringify(snap));

  // 第二轮新实例：尚未 scan，列表已来自快照
  const cache2 = new SessionMetaCache(metaPath);
  const idx2 = new SessionIndex([root], root, undefined, cache2);
  expect(idx2.sessionsView().find(s => s.key === key)?.name).toBe('快照标题X');

  // scan() 只做 stat 校验：文件未变（stamp 匹配）→ 仍信快照，不做全文解析
  idx2.scan();
  expect(idx2.sessionsView().find(s => s.key === key)?.name).toBe('快照标题X');
  idx2.close();
});

it('文件变更后 scan() 重新解析并校正标题，快照随之更新', () => {
  const root = temp();
  const file = path.join(root, 's.jsonl');
  writeSession(file);
  const metaPath = path.join(root, 'session-meta.json');
  const cache1 = new SessionMetaCache(metaPath);
  const idx1 = new SessionIndex([root], root, undefined, cache1);
  const key = idx1.scan()[0].key;
  cache1.flushNow(); idx1.close();

  // 会话追加新的首条 user 不可行（标题取首条 user）；改用 session_info 改名
  fs.appendFileSync(file, JSON.stringify({ type: 'session_info', id: 'n', parentId: 'b', name: '新名字' }) + '\n');
  const cache2 = new SessionMetaCache(metaPath);
  const idx2 = new SessionIndex([root], root, undefined, cache2);
  idx2.scan();
  expect(idx2.sessionsView().find(s => s.key === key)?.name).toBe('新名字');
  cache2.flushNow();
  // 快照已更新为真实名
  const snap = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  expect(snap.items[key].name).toBe('新名字');
  idx2.close();
});

it('文件删除后 scan() 从列表与快照移除', () => {
  const root = temp();
  const file = path.join(root, 's.jsonl');
  writeSession(file);
  const metaPath = path.join(root, 'session-meta.json');
  const cache1 = new SessionMetaCache(metaPath);
  const idx1 = new SessionIndex([root], root, undefined, cache1);
  const key = idx1.scan()[0].key;
  cache1.flushNow(); idx1.close();

  fs.rmSync(file);
  const cache2 = new SessionMetaCache(metaPath);
  const idx2 = new SessionIndex([root], root, undefined, cache2);
  expect(idx2.sessionsView().map(s => s.key)).toContain(key); // 快照先给
  idx2.scan();
  expect(idx2.sessionsView().map(s => s.key)).not.toContain(key); // 校正后消失
  cache2.flushNow();
  expect(JSON.parse(fs.readFileSync(metaPath, 'utf8')).items[key]).toBeUndefined();
  idx2.close();
});

it('快照态条目首次 history 读取触发全量解析，返回真实内容', () => {
  const root = temp();
  const file = path.join(root, 's.jsonl');
  writeSession(file);
  const metaPath = path.join(root, 'session-meta.json');
  const cache1 = new SessionMetaCache(metaPath);
  const idx1 = new SessionIndex([root], root, undefined, cache1);
  const key = idx1.scan()[0].key;
  cache1.flushNow(); idx1.close();

  const idx2 = new SessionIndex([root], root, undefined, new SessionMetaCache(metaPath));
  const h = idx2.history(key); // 点开会话：按需解析
  expect(h.branch.map(e => e.id)).toEqual(['a', 'b']);
  idx2.close();
});

it('快照文件损坏时安全降级为冷扫', () => {
  const root = temp();
  const file = path.join(root, 's.jsonl');
  writeSession(file);
  const metaPath = path.join(root, 'session-meta.json');
  fs.writeFileSync(metaPath, '{ not json');
  const cache = new SessionMetaCache(metaPath);
  const idx = new SessionIndex([root], root, undefined, cache);
  expect(() => idx.scan()).not.toThrow();
  expect(idx.scan()[0]?.name).toBe('真实标题');
  idx.close();
});
