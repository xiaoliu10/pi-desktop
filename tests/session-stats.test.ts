import { describe, expect, it } from 'vitest';
import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConversationStatusPanel } from '../src/renderer/pi/ConversationStatusPanel';
import type { ChatMessage } from '../src/renderer/replica/contracts';
import type { PiSessionStats } from '../src/shared/pi';
import { cacheHitRateFromTotals } from '../src/shared/context-details';

const store = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
(globalThis as any).window = { innerWidth: 1200 };
const base = { cwd: undefined, messages: [] as ChatMessage[], running: false, onReview: () => undefined, onRequest: () => undefined };
const stats: PiSessionStats = { tokens: { input: 100, output: 20, cacheRead: 50, cacheWrite: 50, total: 220 } };
const render = (props: Partial<ComponentProps<typeof ConversationStatusPanel>> = {}) => renderToStaticMarkup(createElement(ConversationStatusPanel, { ...base, stats, ...props }));
const cell = (html: string, label: string) => html.match(new RegExp(`<small>${label}</small><b>([^<]+)</b>`))?.[1];

describe('status panel session stats', () => {
  it('retains existing token breakdown, cost and counts', () => {
    const html = render({ stats: { tokens: { input: 15234, output: 4567, cacheRead: 1_250_000, cacheWrite: 3200, total: 1_273_001 }, cost: 0.1234, totalMessages: 42, toolCalls: 17 } });
    expect(html).toContain('会话统计'); expect(html).toContain('1.27M tokens');
    expect(cell(html, '输入')).toBe('15.2k'); expect(cell(html, '输出')).toBe('4.6k');
    expect(cell(html, '缓存')).toBe('1.25M'); expect(cell(html, '费用')).toBe('$0.12');
    expect(cell(html, '消息')).toBe('42'); expect(cell(html, '工具调用')).toBe('17');
  });

  it('preserves no-stats/fresh-session visibility rules', () => {
    expect(render({ stats: undefined })).not.toContain('会话统计');
    expect(render({ stats: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } })).not.toContain('会话统计');
  });

  it('renders weighted speed, shared cache formula, and tokens/window context (not supplied percent)', () => {
    const html = render({ outputPerformance: { tokens: 250, ms: 400, calls: 2 }, contextUsage: { tokens: 1234, contextWindow: 10000, percent: 99 } });
    expect(cell(html, '输出速度')).toBe('625.0 t/s');
    expect(cell(html, '缓存命中率')).toBe('25.0%'); // 50/(100+50+50); excludes output
    expect(cell(html, '上下文占用')).toBe('12.3%');
    for (const text of ['包含思考 token', '当前连接有效完成调用', '累计输出耗时', '首 token 等待', '工具与审批等待']) expect(html).toContain(text);
  });

  it('uses an independent three-cell grid regardless of optional old cost/counts', () => {
    for (const optional of [{}, { cost: 1 }, { totalMessages: 2 }, { toolCalls: 3 }, { cost: 1, totalMessages: 2, toolCalls: 3 }]) {
      const html = render({ stats: { ...stats, ...optional } });
      const row = html.split('class="pi-status-statgrid pi-status-statgrid--rates"')[1]?.split('</div></div>')[0];
      expect(row).toBeDefined();
      expect([...row!.matchAll(/<small>([^<]+)<\/small>/g)].map(m => m[1])).toEqual(['输出速度', '缓存命中率', '上下文占用']);
      expect(html.match(/class="pi-status-statgrid(?: pi-status-statgrid--rates)?"/g)).toHaveLength(2);
    }
  });

  it('static historic stats never imply measured speed; missing context is —', () => {
    const html = render(); expect(cell(html, '输出速度')).toBe('—'); expect(cell(html, '上下文占用')).toBe('—');
    expect(html).not.toMatch(/—(?:%| t\/s)/);
  });

  it('renders actual zero values as 0.0, not unknown', () => {
    const html = render({ stats: { tokens: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, total: 110 } }, outputPerformance: { tokens: 0, ms: 100, calls: 1 }, contextUsage: { tokens: 0, contextWindow: 10000, percent: 0 } });
    expect(cell(html, '输出速度')).toBe('0.0 t/s'); expect(cell(html, '缓存命中率')).toBe('0.0%'); expect(cell(html, '上下文占用')).toBe('0.0%');
  });

  it.each([null, undefined, { tokens: null, contextWindow: 10000, percent: null }, { tokens: -1, contextWindow: 10000, percent: 10 }, { tokens: NaN, contextWindow: 10000, percent: 10 }, { tokens: Infinity, contextWindow: 10000, percent: 10 }, { tokens: 100, contextWindow: 0, percent: 10 }, { tokens: 100, contextWindow: Infinity, percent: 10 }])('unknown/compaction/invalid context %s is —', contextUsage => {
    expect(cell(render({ contextUsage }), '上下文占用')).toBe('—');
  });

  it('keeps context percentages above 100 (chip clamps ring only, not displayed percent)', () => {
    expect(cell(render({ contextUsage: { tokens: 12000, contextWindow: 10000, percent: 120 } }), '上下文占用')).toBe('120.0%');
  });

  it.each([{ tokens: NaN, ms: 100, calls: 1 }, { tokens: -1, ms: 100, calls: 1 }, { tokens: 100, ms: Infinity, calls: 1 }, { tokens: 100, ms: 0, calls: 1 }, { tokens: 100, ms: -1, calls: 1 }, { tokens: 100, ms: 100, calls: 0 }, { tokens: Number.MAX_VALUE, ms: Number.MIN_VALUE, calls: 1 }])('invalid outputPerformance %s produces bare —', outputPerformance => {
    expect(cell(render({ outputPerformance }), '输出速度')).toBe('—');
  });

  it.each([{ input: 0, cacheRead: 0, cacheWrite: 0 }, { input: -1, cacheRead: 1, cacheWrite: 1 }, { input: 1, cacheRead: NaN, cacheWrite: 1 }, { input: 1, cacheRead: 1, cacheWrite: Infinity }])('invalid/zero denominator cache %s is unknown', tokens => {
    expect(cacheHitRateFromTotals(tokens)).toBeNull();
    expect(cell(render({ stats: { tokens: { ...tokens, output: 10, total: 10 } } }), '缓存命中率')).toBe('—');
  });

  it('cache helper includes cache writes in the denominator, not output tokens', () => {
    expect(cacheHitRateFromTotals({ input: 100, cacheRead: 200, cacheWrite: 100, output: 999999 })).toBe(50);
    expect(cacheHitRateFromTotals(null)).toBeNull();
    expect(cacheHitRateFromTotals(undefined)).toBeNull();
  });
});
