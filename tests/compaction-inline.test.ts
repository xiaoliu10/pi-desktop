import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { executionTurns } from '../src/renderer/replica/chat/execution';
import { ChatView } from '../src/renderer/replica/chat/ChatView';
import { historyToMessages } from '../src/renderer/pi/adapter';
import type { PiEntry } from '../src/shared/pi';

// 压缩记录是时序事件：必须落在过程列表内部的触发点原位（组内步骤行），
// 不再独立成块挂在过程组外面（完成态还会被挪到组后）。
describe('compaction record renders inline in the process list', () => {
  const labels = { you: '你', assistant: 'pi', simulatedRun: '演示', toolRunning: '运行中', toolDone: '完成', toolError: '失败', details: '详情', queued: '排队', working: '执行中' };
  const compactionBranch: PiEntry[] = [
    { id: 'u1', type: 'message', message: { role: 'user', content: '继续排查' } },
    { id: 'a1', type: 'message', message: { role: 'assistant', timestamp: 10, content: [{ type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'a.ts' } }] } },
    { id: 'r1', type: 'message', message: { role: 'toolResult', toolCallId: 'call-1', toolName: 'read', content: 'ok' } },
    // 压缩在两个工具步骤之间触发：pi 原生 compaction + desktop 留痕（留痕抑制原生占位行）
    { id: 'c1', type: 'compaction', timestamp: 20, tokensBefore: 418000, summary: 'summary' } as never,
    { id: 'dc1', type: 'custom', customType: 'desktop-compaction', timestamp: 20, data: { at: 20, durationMs: 148700, tokensBefore: 418000, tokensAfter: 36000, contextWindow: 400000, reason: 'threshold' } } as never,
    { id: 'a2', type: 'message', message: { role: 'assistant', timestamp: 30, content: [{ type: 'toolCall', id: 'call-2', name: 'bash', arguments: { command: 'ls' } }] } },
    { id: 'r2', type: 'message', message: { role: 'toolResult', toolCallId: 'call-2', toolName: 'bash', content: 'done' } },
    // 普通 notice（扩展记录）不进过程列表：仍是独立 text 段
    { id: 'x1', type: 'custom', customType: 'my-extension', timestamp: 31 } as never,
    { id: 'a3', type: 'message', message: { role: 'assistant', timestamp: 40, content: [{ type: 'text', text: '最终结论' } ] } },
  ];

  it('places the compaction notice between the right steps, not in the answer', () => {
    const turn = executionTurns(historyToMessages(compactionBranch))[1]!;
    const kinds = turn.steps.map(p => p.kind);
    expect(kinds).toContain('notice');
    // 时序原位：read 工具之后、bash 工具之前
    expect(kinds.indexOf('notice')).toBeGreaterThan(0);
    expect(kinds.indexOf('notice')).toBeLessThan(kinds.lastIndexOf('tool'));
    // 压缩记录不在答案区；答案区只有结论文本与普通 notice（扩展记录保持原行为）
    const answerTexts = turn.answer.map(p => (p as { text?: string }).text);
    expect(answerTexts).toContain('最终结论');
    expect(answerTexts.some(t => t?.startsWith('上下文压缩'))).toBe(false);
  });

  it('keeps plain extension notices and branch summaries outside the process list', () => {
    const turn = executionTurns(historyToMessages(compactionBranch))[1]!;
    const plain = turn.answer.filter(p => p.kind === 'notice');
    expect(plain.map(p => (p as { text: string }).text)).toEqual(['扩展记录 · my-extension']);
  });

  it('keeps an isolated manual compaction (no adjacent steps) directly visible in the answer area', () => {
    // 手动 /compact：压缩条目落在末轮结论文本之后，前后都没有工具/思考步骤——
    // 入组会折进只显示计时的空组，必须保持直接可见的 text 段。
    // 注意：adapter 的 messageCache 按 entry.id 缓存，两套 fixture 不能共用 id（真实会话是 uuid）。
    const manual: PiEntry[] = [
      { id: 'mu1', type: 'message', message: { role: 'user', content: '压缩一下上下文' } },
      { id: 'ma1', type: 'message', message: { role: 'assistant', timestamp: 10, content: [{ type: 'text', text: '好的，开始压缩。' }] } },
      { id: 'mc1', type: 'compaction', timestamp: 20, tokensBefore: 300000, summary: 's' } as never,
      { id: 'md1', type: 'custom', customType: 'desktop-compaction', timestamp: 20, data: { at: 20, durationMs: 5000, tokensBefore: 300000, tokensAfter: 40000, contextWindow: 400000, reason: 'manual' } } as never,
    ];
    const turn = executionTurns(historyToMessages(manual))[1]!;
    expect(turn.steps.map(p => p.kind)).not.toContain('notice');
    expect(turn.answer.some(p => p.kind === 'notice' && p.strong && (p as { text: string }).text.includes('上下文压缩'))).toBe(true);
    // 分支摘要（无 strong）同理不入组——钉住 adapter 侧「strong 才是压缩」的约定
    const withBranch: PiEntry[] = [...manual, { id: 'b1', type: 'branch_summary', timestamp: 25, summary: 'b' } as never];
    const turn2 = executionTurns(historyToMessages(withBranch))[1]!;
    expect(turn2.steps.some(p => p.kind === 'notice' && (p as { text: string }).text.includes('分支摘要'))).toBe(false);
  });

  it('renders the compaction row inside the execution group at its chronological spot', () => {
    const messages = historyToMessages(compactionBranch);
    const markup = renderToStaticMarkup(createElement(ChatView, { messages, running: false, queued: 0, demo: false, labels, onJumpToMessage: () => {} }));
    expect(markup).toContain('上下文压缩 · 用时 148.7s');
    const stepsStart = markup.indexOf('pi-execution__steps');
    const compaction = markup.indexOf('上下文压缩');
    const conclusion = markup.indexOf('最终结论');
    expect(stepsStart).toBeGreaterThanOrEqual(0);
    expect(compaction).toBeGreaterThan(stepsStart);
    expect(compaction).toBeLessThan(conclusion);
  });
});
