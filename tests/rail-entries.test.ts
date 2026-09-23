import { describe, expect, it } from 'vitest';
import { historyToMessages } from '../src/renderer/pi/adapter';
import { executionTurns } from '../src/renderer/replica/chat/execution';
import { railEntries } from '../src/renderer/replica/chat/ChatView';

const entry = (id: string, role: 'user' | 'assistant', content: unknown, timestamp = 1) =>
  ({ id, type: 'message', timestamp, message: { role, content } });

describe('railEntries', () => {
  /** 用户报的问题：悬浮摘要应是「这组工作的总结」，而非固定文案。 */
  const branch = [
    entry('u1', 'user', '修复登录页'),
    entry('a1', 'assistant', [
      { type: 'thinking', thinking: '先定位问题' },
      { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'login.ts' } },
      { type: 'text', text: '我来看下登录逻辑。' },
      { type: 'toolCall', id: 'c2', name: 'edit', arguments: { path: 'login.ts' } },
      { type: 'text', text: '登录页已修复，根因是 token 过期未刷新。' },
    ]),
    entry('u2', 'user', '继续'),
    entry('a2', 'assistant', [
      { type: 'toolCall', id: 'c3', name: 'bash', arguments: { cmd: 'pnpm test' } },
      { type: 'text', text: '继续完成了配置持久化并补齐测试。' },
    ]),
    // 只有工具没有文本的回合 → 工具步数摘要
    entry('u3', 'user', '再继续'),
    entry('a3', 'assistant', [{ type: 'toolCall', id: 'c4', name: 'read', arguments: { path: 'b.ts' } }]),
  ];

  it('merges each prompt with its execution into one tick', () => {
    const entries = railEntries(executionTurns(historyToMessages(branch as any)));
    expect(entries.map((e) => e.question)).toEqual(['修复登录页', '继续', '再继续']);
    expect(entries[0].summary).toBe('登录页已修复，根因是 token 过期未刷新。');
    expect(entries[0].steps).toBe(2);
  });

  it('uses the conclusion (last text), not the opening commentary', () => {
    const entries = railEntries(executionTurns(historyToMessages(branch as any)));
    expect(entries[0].summary).not.toContain('我来看下');
  });

  it('gives repeated prompts distinct summaries via what the work did', () => {
    const entries = railEntries(executionTurns(historyToMessages(branch as any)));
    expect(entries[0].summary).not.toBe(entries[1].summary);
    expect(entries[1].summary).toBe('继续完成了配置持久化并补齐测试。');
  });

  it('falls back to tool-step summary when the turn has no text', () => {
    const entries = railEntries(executionTurns(historyToMessages(branch as any)));
    expect(entries[2].summary).toBe('1 步工具调用');
  });

  it('keeps a leading execution without prompt as its own tick', () => {
    // executionTurns 会把连续助手消息并入上一回合；只有会话开头的助手内容（如分支摘要）才形成独立刻度
    const head = [entry('a0', 'assistant', [{ type: 'text', text: '分支摘要内容' }]), ...branch];
    const entries = railEntries(executionTurns(historyToMessages(head as any)));
    expect(entries[0]).toMatchObject({ role: 'assistant', question: '', summary: '分支摘要内容' });
    expect(entries).toHaveLength(4);
  });
});
