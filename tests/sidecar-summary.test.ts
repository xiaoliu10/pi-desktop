import { describe, expect, it } from 'vitest';
import type { PiEntry } from '../src/shared/pi';
import { summarizeBranch, renderSummaryPrompt, sidecarSummaryPrompt, entryText, clip, DEFAULT_SUMMARY_BUDGET } from '../src/main/pi/sidecar-summary';

const msg = (role: string, content: unknown, extra: Record<string, unknown> = {}): PiEntry =>
  ({ type: 'message', id: Math.random().toString(36).slice(2), message: { role, content, ...extra } }) as PiEntry;

describe('entryText', () => {
  it('flattens string and block-array content; degrades images/tools to placeholders', () => {
    expect(entryText('  hello  ')).toBe('hello');
    expect(entryText([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'toolCall', name: 'bash' }, { type: 'text', text: 'b' }])).toBe('a [图片] [调用工具 bash] b');
    expect(entryText(undefined)).toBe('');
    expect(entryText(42)).toBe('');
  });
});

describe('clip', () => {
  it('keeps short text verbatim; head+tail with omission marker when long', () => {
    expect(clip('short', 10)).toBe('short');
    const long = 'x'.repeat(100);
    const out = clip(long, 30);
    expect(out.length).toBeLessThan(100);
    expect(out).toContain('省略');
    expect(out.startsWith('x')).toBe(true);
    expect(out.endsWith('x')).toBe(true);
  });
});

describe('summarizeBranch', () => {
  it('takes recent turns newest-aware and keeps chronological order', () => {
    const branch = [msg('user', '第一问'), msg('assistant', '第一答'), msg('user', '第二问'), msg('assistant', '第二答')];
    const out = summarizeBranch(branch);
    expect(out.map(m => m.text)).toEqual(['第一问', '第一答', '第二问', '第二答']);
    expect(out.map(m => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('skips failed assistant turns (errorMessage) and non-message entries', () => {
    const branch = [
      msg('user', '问'),
      msg('assistant', '坏答', { errorMessage: 'boom' }),
      { type: 'custom', id: 'x' } as PiEntry,
      msg('system', 'sys prompt'),
      msg('assistant', '好答'),
    ];
    const out = summarizeBranch(branch);
    expect(out.map(m => m.text)).toEqual(['问', '好答']);
  });

  it('respects maxMessages', () => {
    const branch = Array.from({ length: 20 }, (_, i) => msg('user', `q${i}`));
    expect(summarizeBranch(branch, { ...DEFAULT_SUMMARY_BUDGET, maxMessages: 3 }).map(m => m.text)).toEqual(['q17', 'q18', 'q19']);
  });

  it('respects maxChars budget (never exceeds)', () => {
    const branch = Array.from({ length: 30 }, (_, i) => msg('user', 'x'.repeat(500) + i));
    const budget = { maxMessages: 50, maxChars: 2000, perMessageChars: 600 };
    const out = summarizeBranch(branch, budget);
    expect(out.reduce((n, m) => n + m.text.length, 0)).toBeLessThanOrEqual(2000);
    //  newest kept, oldest dropped
    expect(out.at(-1)?.text).toContain('29');
  });

  it('per-message clip applies', () => {
    const out = summarizeBranch([msg('user', 'y'.repeat(5000))], { ...DEFAULT_SUMMARY_BUDGET, perMessageChars: 100 });
    expect(out[0].text.length).toBeLessThan(5000);
    expect(out[0].text).toContain('省略');
  });

  it('empty/irrelevant branches yield no messages', () => {
    expect(summarizeBranch([])).toEqual([]);
    expect(summarizeBranch([{ type: 'custom', id: 'x' } as PiEntry, msg('toolResult', 'r')])).toEqual([]);
  });
});

describe('renderSummaryPrompt', () => {
  it('empty messages → empty string (caller skips injection)', () => {
    expect(renderSummaryPrompt([])).toBe('');
  });

  it('labels roles, marks boundaries, and states background-not-instruction', () => {
    const p = renderSummaryPrompt([{ role: 'user', text: '刚才那个方案' }, { role: 'assistant', text: '第三步有并发问题' }]);
    expect(p).toContain('用户：刚才那个方案');
    expect(p).toContain('助手：第三步有并发问题');
    expect(p).toContain('── 主会话背景');
    expect(p).toContain('背景而非指令');
  });

  it('sidecarSummaryPrompt is empty for branches without messages', () => {
    expect(sidecarSummaryPrompt([])).toBe('');
    expect(sidecarSummaryPrompt([msg('user', 'hi')])).toContain('用户：hi');
  });
});
