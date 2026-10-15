import { describe, expect, it } from 'vitest';
import { splitUserMeta } from '../src/renderer/pi/adapter';

// 内核注入元消息：/skill: 展开为 <skill>…</skill> 全文、goal 扩展注入确认协议。
// 投影时从正文剥离——正文只留用户真实指令（默认可见），技能全文转折叠块。

describe('splitUserMeta：skill 剥离', () => {
  it('skill 块从正文剥离，正文只留用户指令', () => {
    const text = '<skill name="auto-research" location="/x/SKILL.md">\nReferences are relative to /x.\n</skill>\n\n调研一下';
    const split = splitUserMeta(text);
    expect(split.meta).toBe('skill');
    expect(split.text).toBe('调研一下'); // 用户指令独立可见
    expect(split.skill).toEqual({ name: 'auto-research', text: '\nReferences are relative to /x.\n' });
  });
  it('消息整体就是 skill 注入（无用户指令）时正文为空', () => {
    const split = splitUserMeta('<skill name="x">\n全文\n</skill>');
    expect(split.meta).toBe('skill');
    expect(split.text).toBe('');
    expect(split.skill?.name).toBe('x');
  });
  it('只剥离开头一次：用户指令里手写 <skill> 字样不误伤', () => {
    const text = '<skill name="a">A</skill>\n帮我写个 <skill name="b">B</skill> 的解析';
    const split = splitUserMeta(text);
    expect(split.text).toBe('帮我写个 <skill name="b">B</skill> 的解析');
    expect(split.skill?.text).toBe('A');
  });
  it('skill 标签属性含多余字段也能剥（location 等）', () => {
    const split = splitUserMeta('<skill name="x" location="/y" foo="bar">z</skill>\n做');
    expect(split.meta).toBe('skill');
    expect(split.text).toBe('做');
    expect(split.skill?.name).toBe('x');
  });
});

describe('splitUserMeta：goal 协议', () => {
  it('确认协议/活动协议/topic 都标 protocol 且正文为空（整块是上下文）', () => {
    expect(splitUserMeta('[GOAL CONFIRMATION focus=goal] The user invoked...').meta).toBe('protocol');
    expect(splitUserMeta('[GOAL CONFIRMATION focus=goal] The user invoked...').text).toBe('');
    expect(splitUserMeta('[PI GOAL ACTIVE goalId=x]\nObjective: ...').meta).toBe('protocol');
    expect(splitUserMeta('Topic: <goal_topic> x </goal_topic>').meta).toBe('protocol');
  });
});

describe('splitUserMeta：普通消息', () => {
  it('不打标且正文原样保留', () => {
    expect(splitUserMeta('帮我看看这个 bug')).toEqual({ meta: undefined, text: '帮我看看这个 bug' });
    expect(splitUserMeta('代码里提到 </skill> 字样的普通文本').meta).toBeUndefined();
    expect(splitUserMeta('代码里提到 </skill> 字样的普通文本').text).toBe('代码里提到 </skill> 字样的普通文本');
  });
});
