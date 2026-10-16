import { describe, expect, it } from 'vitest';
import { toolRowIcon } from '../src/renderer/replica/chat/ChatView';

const part = (tool: string) => ({ tool } as Parameters<typeof toolRowIcon>[0]);

// 用户 2026-10-16 指定：子代理在对话流里用机器人图标标识（对齐 ZCode 的
// chat.toolCall 卡片 bot 标识），替代 0.1.24 的常驻横幅形态。
describe('toolRowIcon', () => {
  it('renders subagent tool calls with the bot icon', () => {
    expect(toolRowIcon(part('subagent'), false, null)).toBe('bot');
  });

  it('keeps established icons for plain tools', () => {
    expect(toolRowIcon(part('bash'), false, null)).toBe('terminal');
    expect(toolRowIcon(part('read'), false, null)).toBe('book');
    expect(toolRowIcon(part('edit'), false, null)).toBe('pencil');
    expect(toolRowIcon(part('grep'), false, null)).toBe('search');
  });

  it('codemode and MCP keep priority over the tool itself (shell forms)', () => {
    expect(toolRowIcon(part('codemode'), true, null)).toBe('code');
    expect(toolRowIcon(part('mcp__srv__query'), false, ['srv', 'query'])).toBe('plug');
  });
});
