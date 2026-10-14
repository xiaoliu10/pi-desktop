import { describe, expect, it } from 'vitest';
import { classifyUserMeta } from '../src/renderer/pi/adapter';

describe('classifyUserMeta（内核注入元消息折叠）', () => {
  it('skill 全文块打标 skill', () => {
    const text = '<skill name="auto-research" location="/x/SKILL.md">\nReferences...\n</skill>\n\n调研一下';
    expect(classifyUserMeta(text)).toBe('skill');
  });
  it('goal 确认协议与活动协议打标 protocol', () => {
    expect(classifyUserMeta('[GOAL CONFIRMATION focus=goal] The user invoked...')).toBe('protocol');
    expect(classifyUserMeta('[PI GOAL ACTIVE goalId=x]\nObjective: ...')).toBe('protocol');
    expect(classifyUserMeta('Topic: <goal_topic> x </goal_topic>')).toBe('protocol');
  });
  it('普通消息不打标', () => {
    expect(classifyUserMeta('帮我看看这个 bug')).toBeUndefined();
    expect(classifyUserMeta('代码里提到 </skill> 字样的普通文本')).toBeUndefined();
  });
});
