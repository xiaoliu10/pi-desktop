import { describe, expect, it } from 'vitest';
import { executionTurns } from '../src/renderer/replica/chat/execution';
import type { ChatMessage } from '../src/renderer/replica/chat/contracts';

function build(n: number): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ id: `u${i}`, role: 'user', timestamp: i * 1000, parts: [{ kind: 'text', text: `q${i}` }] } as ChatMessage);
    out.push({ id: `a${i}`, role: 'assistant', timestamp: i * 1000 + 1, parts: [{ kind: 'text', text: `a${i}` }] } as ChatMessage);
  }
  return out;
}

// 复刻 ChatView 的分页算术（renderLimit / hiddenCount / 按钮可见性）。
// 这组测试存在的理由：ChatView 在 node 环境无法渲染，executionTurns 的 limit 语义
// （补载可达性、无 clamp 正反馈、尾部窗口对象一致）必须在这里钉住——PR #137 的
// code review 正是靠等价探针抓到「静态 limit=120 让 880 轮历史永久不可达」。
function pageState(turnsLen: number, renderLimit: number) {
  const hiddenCount = Math.max(0, turnsLen - renderLimit);
  return { renderLimit, hiddenCount, buttonVisible: hiddenCount > 0 };
}

describe('pagination reaches all history (reviewer blocker 1)', () => {
  it('load-earlier keeps working until the first turn', () => {
    const msgs = build(1000); // 2000 messages → 2000 turns (user/assistant each its own group)
    let renderLimit = 60;
    const LOAD_STEP = 60;
    let turns = executionTurns(msgs, renderLimit + LOAD_STEP);
    let state = pageState(turns.length, renderLimit);
    expect(state.buttonVisible).toBe(true);
    // 连续点击直到按钮消失
    let clicks = 0;
    while (state.buttonVisible && clicks < 200) {
      renderLimit = renderLimit + LOAD_STEP;
      turns = executionTurns(msgs, renderLimit + LOAD_STEP);
      state = pageState(turns.length, renderLimit);
      clicks += 1;
    }
    // 关键断言：按钮消失时必须已展开到全部 1000 轮（旧实现 120 处死路，880 轮不可达）。
    // renderLimit 本身可能略超总数（步进 60 不整除），不重要——可见性必须完整。
    const total = executionTurns(msgs).length;
    expect(turns.length).toBe(total);
    expect(state.hiddenCount).toBe(0);
    expect(clicks).toBeLessThan(200);
    expect(renderLimit).toBeGreaterThanOrEqual(total);
  });

  it('tail-window turns are object-identical to full computation (no boundary artifacts)', () => {
    const msgs = build(500);
    const full = executionTurns(msgs);
    const tail = executionTurns(msgs, 60);
    expect(tail.length).toBe(60);
    for (let i = 0; i < tail.length; i += 1) {
      expect(tail[i]).toBe(full[full.length - 60 + i]);
    }
  });

  it('limit does not grow unbounded as the limit rises (no clamp feedback loop)', () => {
    // 回归钉住：renderLimit 递增时 turns 数必须收敛到总量，不能越算越多。
    const msgs = build(1000);
    const total = executionTurns(msgs).length;
    let limit = 60;
    let prev = 0;
    for (let step = 0; step < 60; step += 1) {
      limit += 60;
      const n = executionTurns(msgs, limit).length;
      expect(n).toBeLessThanOrEqual(total);
      expect(n).toBeGreaterThanOrEqual(prev);
      prev = n;
    }
    expect(prev).toBe(total);
  });
});
