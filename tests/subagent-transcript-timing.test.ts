import { it, expect } from 'vitest';
import { subagentTranscriptTurns } from '../src/renderer/pi/subagents';

// 回归：子代理详情面板「已工作 497889 小时」。
// 根因：subagentTranscriptTurns 把缓存版本号 epoch（1、2、3…）填进 PiEntry.timestamp，
// 渲染层把它当 Unix 毫秒与 Date.now() 相减，得到从 1970 年至今的天文数字。
// epoch 的唯一职责是「同一下标内容变化时击穿缓存」，必须走 id 命名空间而不是时间戳。

const user = (extra: Record<string, unknown> = {}) => ({ role: 'user', content: [{ type: 'text', text: 'do the task' }], ...extra });
const assistant = (text: string, extra: Record<string, unknown> = {}) => ({ role: 'assistant', content: [{ type: 'text', text }], ...extra });

it('never treats the cache epoch as a wall-clock timestamp', () => {
  const turns = subagentTranscriptTurns([user(), assistant('working')], 'child-a', 1);
  const assistantTurn = turns.find(t => t.role === 'assistant');
  expect(turns[0]?.startedAt).toBeUndefined();
  expect(assistantTurn?.startedAt).toBeUndefined();
  expect(assistantTurn?.endedAt).toBeUndefined();
});

it('uses real message timestamps when the plugin reports them', () => {
  const t0 = Date.parse('2026-10-19T10:00:00Z');
  const t1 = Date.parse('2026-10-19T10:00:05Z');
  const turns = subagentTranscriptTurns([user({ timestamp: t0 }), assistant('done', { timestamp: t1 })], 'ts-child-b');
  const assistantTurn = turns.find(t => t.role === 'assistant');
  // assistant 执行组从该轮 user 边界计时（executionTurns 口径，与主对话一致）。
  expect(assistantTurn?.startedAt).toBe(t0);
  expect(assistantTurn?.endedAt).toBe(t1);
});

it('epoch change refreshes same-index content without touching timestamps', () => {
  const first = subagentTranscriptTurns([user(), assistant('old')], 'child-c', 1);
  const second = subagentTranscriptTurns([user(), assistant('new-longer-text')], 'child-c', 2);
  expect(first[1]?.answer[0]).toMatchObject({ text: 'old' });
  expect(second[1]?.answer[0]).toMatchObject({ text: 'new-longer-text' });
  expect(second[1]?.startedAt).toBeUndefined();
});

it('keeps different subagents isolated even at the same epoch/index', () => {
  const a = subagentTranscriptTurns([user(), assistant('A result')], 'iso-child-a', 1);
  const b = subagentTranscriptTurns([user(), assistant('B result')], 'iso-child-b', 1);
  expect(a[1]?.answer[0]).toMatchObject({ text: 'A result' });
  expect(b[1]?.answer[0]).toMatchObject({ text: 'B result' });
});

it('ignores non-finite bogus timestamps instead of fabricating elapsed time', () => {
  const turns = subagentTranscriptTurns(
    [user({ timestamp: 'not-a-date' }), assistant('x', { timestamp: NaN })],
    'child-d',
    3,
  );
  expect(turns[0]?.startedAt).toBeUndefined();
  expect(turns[1]?.endedAt).toBeUndefined();
});
