import { describe, expect, it } from 'vitest';
import { historyToMessages, type CompactionAfter } from '../src/renderer/pi/adapter';

// 压缩留痕文案：before 口径（pi 原生 compaction entry tokensBefore）+ after 回填
// （主进程 compaction-record 事件，按留痕 at ±15s 匹配）。回填后「前 → 后 · 窗口」。
const entry = (data: Record<string, unknown> = {}) => [
  { id: 'c1', type: 'compaction', summary: 's', firstKeptEntryId: null, tokensBefore: 615000 } as any,
  { id: 'd1', customType: 'desktop-compaction', data: { at: 1000, durationMs: 60100, tokensBefore: 615000, contextWindow: 400000, ...data } } as any,
];

describe('压缩记录 after 回填', () => {
  it('回填匹配（at ±15s）→ 文案「前 → 后 · 窗口」', () => {
    const after: CompactionAfter = { at: 12000, tokensAfter: 35000, contextWindow: 400000 };
    const msgs = historyToMessages(entry(), after);
    const notice = msgs.find(m => m.parts.some(p => p.kind === 'notice'))?.parts[0] as any;
    expect(notice.strong).toBe(true);
    expect(notice.text).toContain('60.1s');
    expect(notice.text).toContain('615k → 35k tokens');
    expect(notice.text).toContain('窗口 400k');
  });

  it('at 超出 ±15s（陈旧回填）→ 退化为「压缩前 X · 窗口」', () => {
    const after: CompactionAfter = { at: 999_000, tokensAfter: 35000, contextWindow: 400000 };
    const msgs = historyToMessages(entry(), after);
    const notice = msgs.find(m => m.parts.some(p => p.kind === 'notice'))?.parts[0] as any;
    expect(notice.text).toContain('压缩前 615k tokens');
    expect(notice.text).toContain('窗口 400k');
    expect(notice.text).not.toContain('→');
  });

  it('无回填（历史会话重开）→ 维持「压缩前 X tokens · 窗口」', () => {
    const msgs = historyToMessages(entry());
    const notice = msgs.find(m => m.parts.some(p => p.kind === 'notice'))?.parts[0] as any;
    expect(notice.text).toBe('上下文压缩 · 用时 60.1s · 压缩前 615k tokens · 窗口 400k');
  });

  it('旧版留痕（data 自带 tokensAfter）直接显示「前 → 后」，无需回填', () => {
    const msgs = historyToMessages(entry({ tokensAfter: 35000 }));
    const notice = msgs.find(m => m.parts.some(p => p.kind === 'notice'))?.parts[0] as any;
    expect(notice.text).toContain('615k → 35k tokens');
    expect(notice.text).toContain('窗口 400k');
  });

  it('无留痕（纯 CLI 会话）→ 保留 pi 原生占位行并显示压缩前 tokens', () => {
    const msgs = historyToMessages([
      { id: 'c2', type: 'compaction', tokensBefore: 1250000, summary: '摘要', firstKeptEntryId: 'x' },
    ] as any);
    expect(msgs).toHaveLength(1);
    const text = JSON.stringify(msgs[0].parts);
    expect(text).toContain('上下文压缩记录');
    expect(text).toContain('1.3M');
  });

  it('留痕渲染时抑制紧邻的 pi 原生占位行（一条压缩只显示一条记录）', () => {
    const msgs = historyToMessages(entry());
    expect(msgs).toHaveLength(1);
    expect(JSON.stringify(msgs[0].parts)).toContain('上下文压缩');
    expect(JSON.stringify(msgs[0].parts)).not.toContain('上下文压缩记录');
  });

  it('紧邻条目是 policy-audit 时不误吞 pi 原生占位行（抑制只对 desktop-compaction）', () => {
    const msgs = historyToMessages([
      { id: 'c1', type: 'compaction', tokensBefore: 428000, summary: '摘要', firstKeptEntryId: 'x' },
      { id: 'a1', customType: 'desktop-policy-audit' },
    ] as any);
    expect(msgs).toHaveLength(1); // 审计条本身被过滤（desktop-policy-audit return），但占位行必须保留
    const text = JSON.stringify(msgs[0].parts);
    expect(text).toContain('上下文压缩记录'); // pi 原生占位行保留（未被误吞）
    expect(text).toContain('428k');
  });

  it('desktop-compaction 条目不进 messageCache（回填到达后重装配能拿到新文案）', () => {
    const noAfter = historyToMessages(entry());
    const withAfter = historyToMessages(entry(), { at: 1000, tokensAfter: 35000, contextWindow: 400000 });
    const a = noAfter.find(m => m.parts.some(p => p.kind === 'notice'))?.parts[0] as any;
    const b = withAfter.find(m => m.parts.some(p => p.kind === 'notice'))?.parts[0] as any;
    expect(a.text).not.toBe(b.text);
  });
});
