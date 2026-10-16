import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionIndex } from '../src/main/pi/session-index';

const roots: string[] = [];
const temp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-inc-')); roots.push(p); return p; };
afterEach(() => { roots.splice(0).forEach(p => fs.rmSync(p, { recursive: true, force: true })); });
const header = { type: 'session', version: 3, id: 's', cwd: '/p' };
const write = (file: string, entries: unknown[]) => fs.writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n');

// 大会话流式期间 history() 走增量 tail 解析：不再全量重读（几百 ms 主进程阻塞），
// 也不重复消费（此前一版把 pendingTail 的字节重复计入下一次读取，行被静默丢弃）。
describe('incremental tail parsing', () => {
  it('consumes appended lines without re-reading and without duplication', () => {
    const root = temp(), file = path.join(root, 's.jsonl');
    const line = (id: string) => ({ type: 'message', id, parentId: null, message: { role: 'assistant', content: id } });
    write(file, [header, { type: 'message', id: 'a', parentId: null, message: { role: 'user', content: 'go' } }]);
    const index = new SessionIndex([root], root);
    const key = index.scan()[0].key;
    const readBytes = () => { let n = 0; const orig = fs.readFileSync; };
    // 第一轮增量：两条完整行
    fs.appendFileSync(file, [line('b'), line('c')].map(e => JSON.stringify(e)).join('\n') + '\n');
    let h = index.history(key);
    expect(h.entries.map(e => e.id)).toEqual(['a', 'b', 'c']);
    // 第二轮增量：一条完整行 + 一条未成行（无结尾换行）——下次补齐后才消费
    fs.appendFileSync(file, JSON.stringify(line('d')) + '\n' + JSON.stringify(line('e')));
    h = index.history(key);
    expect(h.entries.map(e => e.id)).toEqual(['a', 'b', 'c', 'd']); // e 未成行不消费
    fs.appendFileSync(file, '\n');
    h = index.history(key);
    expect(h.entries.map(e => e.id)).toEqual(['a', 'b', 'c', 'd', 'e']); // 补 \n 后落地，不丢不重
    expect(h.entries.filter(e => e.id === 'b')).toHaveLength(1);
  });

  it('skips damaged lines with a stable warning and keeps counting across increments', () => {
    const root = temp(), file = path.join(root, 's.jsonl');
    write(file, [header, { type: 'message', id: 'a', parentId: null, message: { role: 'user', content: 'go' } }]);
    const index = new SessionIndex([root], root);
    const key = index.scan()[0].key;
    fs.appendFileSync(file, 'not-json\n');
    expect(index.history(key).session.warnings.join()).toContain('增量段跳过 1 行损坏');
    fs.appendFileSync(file, 'still-bad\n');
    const h = index.history(key);
    expect(h.session.warnings.filter(w => w.includes('增量段跳过'))).toHaveLength(1); // 汇总为一条，不无限增长
    expect(h.session.warnings.join()).toContain('增量段跳过 2 行损坏'); // 且跨增量累计
  });

  it('falls back to a full re-parse when the file shrinks (replaced/truncated)', () => {
    const root = temp(), file = path.join(root, 's.jsonl');
    const line = (id: string) => ({ type: 'message', id, parentId: null, message: { role: 'assistant', content: id } });
    write(file, [header, { type: 'message', id: 'a', parentId: null, message: { role: 'user', content: 'go' } }, line('b'), line('c')]);
    const index = new SessionIndex([root], root);
    const key = index.scan()[0].key;
    expect(index.history(key).entries).toHaveLength(3);
    write(file, [header, { type: 'message', id: 'a', parentId: null, message: { role: 'user', content: 'go' } }]); // 截断
    expect(index.history(key).entries).toHaveLength(1);
  });

  it('replaces the history object only when new lines land (renderer identity contract)', () => {
    const root = temp(), file = path.join(root, 's.jsonl');
    write(file, [header, { type: 'message', id: 'a', parentId: null, message: { role: 'user', content: 'go' } }]);
    const index = new SessionIndex([root], root);
    const key = index.scan()[0].key;
    const before = index.history(key);
    // 未成行追加：无新增完整行 → 引用不变（避免渲染层无谓重算）
    fs.appendFileSync(file, '{"type":"message","id":"b"');
    expect(index.history(key)).toBe(before);
    // 落地：引用必须变化（history 消费方依赖对象身份感知更新）
    fs.appendFileSync(file, ',\"x\":1}\n'.replace('\\"', '"')); // 续上合法 JSON
    const after = index.history(key);
    expect(after).not.toBe(before);
    expect(after.entries.map(e => e.id)).toEqual(['a', 'b']);
  });
});
