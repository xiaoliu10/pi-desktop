import { describe, expect, it } from 'vitest';
import { conversationMessages } from '../src/renderer/pi/adapter';
import { executionTurns } from '../src/renderer/replica/chat/execution';

// 千条级会话回放：流式事件每秒多条重建 messages，行级 memo 依赖 turn 身份稳定。
// 使用合成数据（不依赖本机会话文件），但保持同等规模与结构。
const total = 1000;
const raw = Array.from({ length: total }, (_, i) => {
  if (i > 0 && i % 200 === 0) return { type: 'compaction', id: `c${i}` };
  const role = i % 2 === 0 ? 'user' : 'assistant';
  const content = role === 'user'
    ? [{ type: 'text', text: `请求 ${i}` }]
    : [
        { type: 'thinking', thinking: `思考 ${i}` },
        { type: 'toolCall', id: `t${i}`, name: 'read', arguments: { path: `src/file-${i}.ts` } },
        { type: 'text', text: `回复 ${i}` },
      ];
  // 真实 pi entry 每条都有稳定 uuid id；缓存按 id+timestamp 命中，身份保持靠它。
  return { type: 'message', id: `e${i}`, timestamp: 1700000000000 + i, message: { role, timestamp: 1700000000000 + i, content } };
});

describe('turn identity stability for memoized rows', () => {
  it('reuses message and turn objects for unchanged history across rebuilds', () => {
    const a = conversationMessages(raw as any, undefined, []);
    const t0 = performance.now();
    const b = conversationMessages(raw as any, undefined, []);
    const warm = performance.now() - t0;
    expect(a.length).toBeGreaterThan(total / 4);
    expect(a).toHaveLength(b.length);
    for (let i = 0; i < a.length; i++) expect(b[i]).toBe(a[i]);
    const ta = executionTurns(a);
    const tb = executionTurns(b);
    expect(ta).toHaveLength(tb.length);
    for (let i = 0; i < ta.length; i++) expect(tb[i]).toBe(ta[i]);
    // 暖路径应当显著快于构建（这里只要求亚毫秒级量级，不设硬阈值防抖动）
    expect(warm).toBeLessThan(50);
  });

  it('keeps history turn identities while a live turn streams', () => {
    const history = conversationMessages(raw as any, undefined, []);
    const live1 = { '9999': { role: 'assistant', timestamp: 9999, content: [{ type: 'thinking', thinking: '第一段思考' }] } };
    const withLive1 = executionTurns(conversationMessages(raw as any, live1 as any, []));
    const live2 = { '9999': { role: 'assistant', timestamp: 9999, content: [{ type: 'thinking', thinking: '第一段思考…第二段思考' }] } };
    const withLive2 = executionTurns(conversationMessages(raw as any, live2 as any, []));
    expect(withLive1.length).toBe(withLive2.length);
    // 流式只动最后一轮：历史轮身份必须全部保持，仅最后一轮变化
    for (let i = 0; i < withLive1.length - 1; i++) expect(withLive2[i]).toBe(withLive1[i]);
    expect(withLive2[withLive2.length - 1]).not.toBe(withLive1[withLive1.length - 1]);
    expect(history.length).toBeGreaterThan(0);
  });
});
