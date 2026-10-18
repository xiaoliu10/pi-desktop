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
    fs.appendFileSync(file, ',"x":1}\n'); // 续上合法 JSON
    const after = index.history(key);
    expect(after).not.toBe(before);
    expect(after.entries.map(e => e.id)).toEqual(['a', 'b']);
  });
});

// 回归（review P1）：rename-replace（新 inode、size 更大）曾把替换误判为追加并污染
// stamp，scan() 永不纠正——持久性静默错误历史。同尺寸原地改写曾静默吞掉。
it('full re-parses when the file is replaced via rename (new inode) or rewritten in place', () => {
  const root = temp(), file = path.join(root, 's.jsonl');
  const line = (id: string) => ({ type: 'message', id, parentId: null, message: { role: 'assistant', content: id } });
  write(file, [header, { type: 'message', id: 'a', parentId: null, message: { role: 'user', content: 'go' } }, line('old')]);
  const index = new SessionIndex([root], root);
  const key = index.scan()[0].key;
  expect(index.history(key).entries.map(e => e.id)).toEqual(['a', 'old']);
  // rename-replace：新 inode、更大内容
  const replacement = path.join(root, 'replacement.jsonl');
  write(replacement, [header, { type: 'message', id: 'a', parentId: null, message: { role: 'user', content: 'go' } }, line('new1'), line('new2')]);
  fs.renameSync(replacement, file);
  expect(index.history(key).entries.map(e => e.id)).toEqual(['a', 'new1', 'new2']);
  // 同尺寸原地改写（mtime 变化）：无法廉价判别 → 回退全量，内容以新为准
  const sameSize = fs.readFileSync(file, 'utf8').replace('"new2"', '"n2w2"');
  fs.writeFileSync(file, sameSize);
  fs.utimesSync(file, new Date(), new Date(Date.now() + 50));
  expect(index.history(key).entries.map(e => e.id)).toEqual(['a', 'new1', 'n2w2']);
});

// 回归（review P2）：header-only 首扫 + 首条 user 经增量落地 → 派生标题，不再「未命名」
it('derives the session title from the first user message landing via increments', () => {
  const root = temp(), file = path.join(root, 's.jsonl');
  write(file, [header]);
  const index = new SessionIndex([root], root);
  const key = index.scan()[0].key;
  expect(index.history(key).session.name).toBe('未命名 pi 会话');
  fs.appendFileSync(file, JSON.stringify({ type: 'message', id: 'u', parentId: null, message: { role: 'user', content: '帮我分析这段报错日志' } }) + '\n');
  expect(index.history(key).session.name).toBe('帮我分析这段报错日志');
});

// 「进程」区块跨窗口持久（2026-10-18）：主进程 lastPlan 从全量 entries 提取最后一次
// 成功的 desktop_update_plan 结果。真实 jsonl 形态：toolResult 是独立 entry，
// toolName 在 message 层——此前误扫 message.content 里的 block，一次都扫不到。
describe('history.plan extraction (desktop_update_plan)', () => {
  it('extracts the last successful plan from toolResult entries (message-level toolName)', () => {
    const root = temp(), file = path.join(root, 's.jsonl');
    const planResult = (id: string, parentId: string, plan: unknown[]) => ({
      type: 'message', id, parentId,
      message: { role: 'toolResult', toolCallId: `call_${id}`, toolName: 'desktop_update_plan', content: [{ type: 'text', text: JSON.stringify({ plan }) }] },
    });
    // 500+ 条填充，把清单调用挤出 tail 窗口——模拟长任务早期建板
    const fillers = Array.from({ length: 520 }, (_, i) => ({ type: 'message', id: `f${i}`, parentId: null, message: { role: 'assistant', content: `filler ${i}` } }));
    write(file, [
      header,
      { type: 'message', id: 'u0', parentId: null, message: { role: 'user', content: 'do it' } },
      { type: 'message', id: 'c1', parentId: 'u0', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call_p1', name: 'desktop_update_plan', arguments: { plan: [] } }] } },
      planResult('p1', 'c1', [{ step: '旧任务', status: 'completed' }]),
      ...fillers,
      { type: 'message', id: 'c2', parentId: 'f519', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call_p2', name: 'desktop_update_plan', arguments: { plan: [] } }] } },
      planResult('p2', 'c2', [{ step: '新任务A', status: 'completed' }, { step: '新任务B', status: 'in_progress' }]),
    ]);
    const index = new SessionIndex([root], root);
    const key = index.scan()[0].key;
    const h = index.history(key, undefined, { tail: 500 });
    expect(h.plan).toEqual([{ step: '新任务A', status: 'completed' }, { step: '新任务B', status: 'in_progress' }]);
  });

  it('ignores malformed plan payloads and keeps scanning', () => {
    const root = temp(), file = path.join(root, 's.jsonl');
    write(file, [
      header,
      { type: 'message', id: 'c0', parentId: null, message: { role: 'assistant', content: 'x' } },
      { type: 'message', id: 'bad', parentId: 'c0', message: { role: 'toolResult', toolCallId: 'x', toolName: 'desktop_update_plan', content: [{ type: 'text', text: '{"plan":"不是数组"}' }] } },
      { type: 'message', id: 'good', parentId: 'bad', message: { role: 'toolResult', toolCallId: 'y', toolName: 'desktop_update_plan', content: [{ type: 'text', text: '{"plan":[{"step":"唯一","status":"pending"}]}' }] } },
    ]);
    const index = new SessionIndex([root], root);
    const key = index.scan()[0].key;
    // renderer 的 history 调用总带 tail（首屏分页契约）；plan 只在 wireLite 路径附发。
    const h = index.history(key, undefined, { tail: 500 });
    expect(h.plan).toEqual([{ step: '唯一', status: 'pending' }]);
  });
});
