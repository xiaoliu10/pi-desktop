import { describe, expect, it } from 'vitest';
import { sentConversationMessages } from '../src/renderer/pi/adapter';
import type { PiEntry } from '../src/shared/pi';

// sentConversationMessages 的 segment 缓存语义（渲染性能优化的正确性边界）：
// 缓存按 branch 数组身份隔离，key 含区间 + owner + live/tools 内容签名（JSON.stringify）。
// 这组测试钉住「缓存命中不得改变行为」的四条边界。id 每个用例独立前缀，避免模块级
// messageCache（entry.id:timestamp 键）跨用例串扰。

const entry = (id: string, role: string, content: unknown): PiEntry => ({ id, type: 'message', message: { role, content } } as PiEntry);

describe('sentConversationMessages segment cache', () => {
  it('reflects same-id live content growth across calls on one branch (streaming delta)', () => {
    // 流式 delta 原地更新同 id 的 live 消息：id 不变、内容增长。id-only 签名会命中
    // 陈旧段（真实回归过：pi-send-boundaries 的 late-delta 场景），这里直接钉住。
    const branch = [entry('g-u1', 'user', 'hello'), entry('g-a1', 'assistant', [{ type: 'text', text: 'saved answer' }])];
    const live = (text: string) => ({ '701': { id: '701', role: 'assistant', content: [{ type: 'text', text }] } });
    const liveText = (out: ReturnType<typeof sentConversationMessages>) => out.filter(m => String(m.id).startsWith('live-')).flatMap(m => m.parts.map(p => (p as { text?: string }).text)).join('|');
    const first = sentConversationMessages(branch, live('NEW'), undefined, [], undefined);
    expect(liveText(first)).toBe('NEW');
    const second = sentConversationMessages(branch, live('NEW CONTINUED'), undefined, [], undefined);
    expect(liveText(second)).toBe('NEW CONTINUED');
  });

  it('keeps history message identities across stream ticks (live changes)', () => {
    const branch = [entry('i-u1', 'user', 'q1'), entry('i-a1', 'assistant', [{ type: 'text', text: 'r1' }]), entry('i-u2', 'user', 'q2'), entry('i-a2', 'assistant', [{ type: 'text', text: 'r2' }])];
    const base = sentConversationMessages(branch, undefined, undefined, [], undefined);
    const tick = (text: string) => sentConversationMessages(branch, { s: { id: 's', role: 'assistant', content: [{ type: 'text', text }] } }, undefined, [], undefined);
    const t1 = tick('streaming…');
    const t2 = tick('streaming… more');
    // 历史（非 live）元素引用恒等：React.memo 链的根基（live 消息带合成时间戳，插入位置随历史时间戳分布，不可按固定位对齐）
    const hist = (out: ReturnType<typeof sentConversationMessages>) => out.filter(m => !String(m.id).startsWith('live-'));
    const h1 = hist(t1); const h2 = hist(t2);
    expect(h1).toHaveLength(base.length); expect(h2).toHaveLength(base.length);
    for (let i = 0; i < base.length; i += 1) { expect(h1[i]).toBe(base[i]); expect(h2[i]).toBe(base[i]); }
    expect(t1.some(m => String(m.id).startsWith('live-') && m.parts.some(p => (p as { text?: string }).text === 'streaming…'))).toBe(true);
    expect(t2.some(m => String(m.id).startsWith('live-') && m.parts.some(p => (p as { text?: string }).text === 'streaming… more'))).toBe(true);
  });

  it('routes a late tool progress to the tail segment after the cache warmed', () => {
    // late progress 归属：progress 在缓存预热后才到，必须穿透缓存进入活动段
    const branch = [entry('l-u1', 'user', 'q1'), entry('l-a1', 'assistant', [{ type: 'text', text: 'r1' }])];
    const warm = sentConversationMessages(branch, undefined, undefined, [], undefined);
    expect(warm.some(m => String(m.id).startsWith('live-tools'))).toBe(false);
    const late = sentConversationMessages(branch, undefined, [{ toolCallId: 'late-call', name: 'bash', text: 'ls', status: 'running' } as never], [], undefined);
    expect(late.some(m => String(m.id).startsWith('live-tools'))).toBe(true);
  });

  it('re-renders tool part when same-id tool progress content churns', () => {
    // 同 toolCallId 的进度部分结果流式更新（text 变化）：tools 签名是 JSON.stringify，
    // 仅计数签名会命中陈旧段（reviewer 变异测试证实该缺口）。
    const branch = [entry('c-u1', 'user', 'q1')];
    const tools = (text: string) => [{ toolCallId: 'tc1', name: 'bash', text, status: 'running' } as never];
    const toolTexts = (out: ReturnType<typeof sentConversationMessages>) => out.flatMap(m => m.parts).filter((p): p is Extract<typeof p, { kind: 'tool' }> => p.kind === 'tool').map(p => (p.detailLines ?? [])[0]);
    const first = sentConversationMessages(branch, undefined, tools('ls'), [], undefined);
    const second = sentConversationMessages(branch, undefined, tools('ls -la src/'), [], undefined);
    expect(toolTexts(first)).toContain('ls');
    expect(toolTexts(second)).toContain('ls -la src/');
    expect(toolTexts(second)).not.toContain('ls');
  });

  it('routes live message to its owner segment via _turnId', () => {
    // live _turnId → owner 段路由直断言：无 sends 时 owner=undefined，带 _turnId 的 live
    // 落入同 owner 段（live-tools 消息 id 后缀 = owner）。
    const branch = [entry('t-u1', 'user', 'q1'), entry('t-a1', 'assistant', [{ type: 'text', text: 'r1' }])];
    const out = sentConversationMessages(
      branch,
      { s1: { id: 's1', role: 'assistant', content: [{ type: 'text', text: 'live body' }] } },
      [{ toolCallId: 'tc9', name: 'read', text: 'x', status: 'running' } as never],
      [],
      undefined,
    );
    // 两者 owner 均为 undefined → 都在唯一 segment 里渲染出来
    expect(out.some(m => String(m.id).startsWith('live-') && m.parts.some(p => (p as { text?: string }).text === 'live body'))).toBe(true);
    expect(out.some(m => String(m.id).startsWith('live-tools'))).toBe(true);
  });

  it('picks up appended entries after an IPC refresh (new branch array)', () => {
    const branch1 = [entry('r-u1', 'user', 'q1'), entry('r-a1', 'assistant', [{ type: 'text', text: 'r1' }])];
    const first = sentConversationMessages(branch1, undefined, undefined, [], undefined);
    expect(first).toHaveLength(2);
    // refresh：主进程结构化克隆出全新数组与全新 entry 对象（append-only 追加）
    const branch2 = [...branch1.map(e => ({ ...e })), entry('r-u2', 'user', 'q2'), entry('r-a2', 'assistant', [{ type: 'text', text: 'r2' }])];
    const second = sentConversationMessages(branch2, undefined, undefined, [], undefined);
    expect(second).toHaveLength(4);
    // 历史元素身份稳定（messageCache 按 entry.id+timestamp 命中）
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
  });
});
