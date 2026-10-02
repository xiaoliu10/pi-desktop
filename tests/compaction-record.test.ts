import { describe, expect, it } from 'vitest';
import { historyToMessages } from '../src/renderer/pi/adapter';

// 上下文压缩在过程记录里留痕（用户要求：用时多久、压缩前/压缩后 tokens）：
// desktop-policy 扩展在 session_compact 时写入 desktop-compaction custom entry（持久化），
// 渲染端渲染完整记录并抑制紧邻的 pi 原生占位行，一条压缩只显示一条。
describe('上下文压缩记录（过程记录留痕）', () => {
  it('desktop-compaction 留痕渲染完整记录（用时 + 压缩前后 tokens），并抑制 pi 原生占位行', () => {
    const messages = historyToMessages([
      { id: 'c1', type: 'compaction', tokensBefore: 428000, summary: '摘要', firstKeptEntryId: 'x' },
      { id: 'd1', type: 'custom', customType: 'desktop-compaction', data: { at: 1, durationMs: 12300, tokensBefore: 428000, tokensAfter: 35000 } },
    ] as never);
    expect(messages).toHaveLength(1); // 一条压缩只显示一条记录
    const text = JSON.stringify(messages[0].parts);
    expect(text).toContain('上下文压缩');
    expect(text).toContain('用时 12.3s');
    expect(text).toContain('428k → 35k tokens');
  });

  it('无留痕时保留 pi 原生占位行，并显示压缩前 tokens（纯 CLI 会话）', () => {
    const messages = historyToMessages([
      { id: 'c2', type: 'compaction', tokensBefore: 1250000, summary: '摘要', firstKeptEntryId: 'x' },
    ] as never);
    expect(messages).toHaveLength(1);
    const text = JSON.stringify(messages[0].parts);
    expect(text).toContain('上下文压缩记录');
    expect(text).toContain('1.3M');
  });

  it('留痕数据不全时优雅退化：缺压缩后只显示压缩前，缺用时省略用时段', () => {
    const messages = historyToMessages([
      { id: 'd2', type: 'custom', customType: 'desktop-compaction', data: { tokensBefore: 428000 } },
    ] as never);
    expect(messages).toHaveLength(1);
    const text = JSON.stringify(messages[0].parts);
    expect(text).toContain('上下文压缩 · 压缩前 428k tokens');
    expect(text).not.toContain('用时');
    expect(text).not.toContain('→');
  });

  it('紧邻留痕的是别的 custom 条目时不抑制 pi 行（防误吞）', () => {
    const messages = historyToMessages([
      { id: 'c3', type: 'compaction', tokensBefore: 1000, summary: '摘要', firstKeptEntryId: 'x' },
      { id: 'a3', type: 'custom', customType: 'desktop-policy-audit', data: {} },
    ] as never);
    expect(messages).toHaveLength(1); // policy-audit 自身不渲染，但 pi 行保留
    expect(JSON.stringify(messages[0].parts)).toContain('上下文压缩记录');
  });
});
