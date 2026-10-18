import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionIndex } from '../src/main/pi/session-index';

// 索引层契约：索引=entry 链表（稳定 id + parentId），摘要=user 消息/工具参数。
// 搜索只回定位信息（entryId + preview），命中后由 history(before) 取回整段。
// 用合成会话钉住：命中数/preview 截断/limit/空 query/大纲章节结构。
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idx-'));

function writeSession(dir: string, entries: any[]) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  return file;
}

const user = (id: string, text: string, parent: string | null) => ({ type: 'message', id, parentId: parent, timestamp: '2026-10-18T00:00:0' + id.slice(-1) + 'Z', message: { role: 'user', content: [{ type: 'text', text }] } });
const assistant = (id: string, blocks: any[], parent: string) => ({ type: 'message', id, parentId: parent, timestamp: '2026-10-18T00:01:00Z', message: { role: 'assistant', content: blocks } });

describe('session search & outline (index = entry chain)', () => {
  it('finds hits with previews and turn attribution', () => {
    const dir = temp();
    const entries = [
      { type: 'session', version: 3, id: 's', cwd: dir },
      user('u1', '修复侧栏菊花不转的问题', null),
      assistant('a1', [{ type: 'text', text: '先看 runningSubagentCounts 的实现，索引计数在那里' }], 'u1'),
      user('u2', '给大会话加索引和摘要', 'a1'),
      assistant('a2', [{ type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'grep -rn 索引 src/' } }], 'u2'),
      { type: 'message', id: 'r1', parentId: 'a2', timestamp: '2026-10-18T00:02:00Z', message: { role: 'toolResult', toolCallId: 't1', toolName: 'bash', content: [{ type: 'text', text: 'src/main/pi/session-index.ts: 索引实现' }] } },
    ];
    writeSession(dir, entries);
    const index = new SessionIndex([dir], dir);
    const key = index.scan()[0].key;

    const all = index.searchSession(key, '索引');
    expect(all.total).toBeGreaterThanOrEqual(2);
    expect(all.hits.every(h => h.preview.includes('索引'))).toBe(true);
    expect(all.hits.every(h => h.entryId.length > 0)).toBe(true);
    // turn 归属：a1 的命中挂在 u1 轮，a2/r1 的命中挂在 u2 轮
    const a1 = all.hits.find(h => h.entryId === 'a1');
    expect(a1?.turnEntryId).toBe('u1');
    expect(all.hits.find(h => h.entryId === 'r1')?.turnEntryId).toBe('u2');
  });

  it('honors limit and reports the true total', () => {
    const dir = temp();
    const entries: any[] = [{ type: 'session', version: 3, id: 's', cwd: dir }, user('u0', '批量命中测试', null)];
    let parent = 'u0';
    for (let i = 0; i < 20; i += 1) {
      entries.push(assistant(`a${i}`, [{ type: 'text', text: `第 ${i} 次命中测试` }], parent));
      parent = `a${i}`;
    }
    writeSession(dir, entries);
    const index = new SessionIndex([dir], dir);
    const key = index.scan()[0].key;
    const out = index.searchSession(key, '命中测试', { limit: 5 });
    expect(out.hits.length).toBe(5);
    expect(out.total).toBe(21); // 1 user + 20 assistant，全部命中
  });

  it('returns nothing for an empty query', () => {
    const dir = temp();
    writeSession(dir, [{ type: 'session', version: 3, id: 's', cwd: dir }, user('u1', '你好', null)]);
    const index = new SessionIndex([dir], dir);
    const key = index.scan()[0].key;
    expect(index.searchSession(key, '   ')).toEqual({ total: 0, hits: [] });
  });

  it('outline maps user turns with tool counts and image flags', () => {
    const dir = temp();
    writeSession(dir, [
      { type: 'session', version: 3, id: 's', cwd: dir },
      user('u1', '第一轮：带图', null),
      assistant('a1', [{ type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'ls' } }, { type: 'toolCall', id: 't2', name: 'read', arguments: { path: 'x' } }], 'u1'),
      { type: 'message', id: 'r1', parentId: 'a1', timestamp: '2026-10-18T00:02:00Z', message: { role: 'toolResult', toolCallId: 't1', toolName: 'bash', content: 'ok' } },
      user('u2', '第二轮：也带图', 'r1'),
      { type: 'message', id: 'u3', parentId: 'u2', timestamp: '2026-10-18T00:03:00Z', message: { role: 'user', content: [{ type: 'text', text: '图' }, { type: 'image', mimeType: 'image/png', data: 'AAAA' }] } },
    ]);
    const index = new SessionIndex([dir], dir);
    const key = index.scan()[0].key;
    const outline = index.sessionOutline(key);
    expect(outline.turns.length).toBe(3);
    expect(outline.turns[0]).toMatchObject({ entryId: 'u1', title: '第一轮：带图', toolCount: 2, hasImages: false });
    expect(outline.turns[2]).toMatchObject({ entryId: 'u3', hasImages: true });
    expect(outline.total).toBe(3);
  });
});
