import { describe, expect, it } from 'vitest';
import type { ContextItem } from '../src/shared/composer';
import {
  appendPromptHistoryEntry,
  navigatePromptHistory,
  readPromptHistory,
  persistPromptHistory,
} from '../src/renderer/replica/prompt-history';

// ZCode promptHistory/promptHistoryStorage 移植：↑↓ 回看已发送消息。
// 富条目：一次发送可能携带图片/文件/技能等 ContextItem，recall 原样还原。
type Item = Omit<ContextItem, 'id'>;
const img: Item = { name: '截图.png', path: '/tmp/截图.png', kind: 'image', text: '', image: { type: 'image', mimeType: 'image/png', data: 'aGk=' } };
const doc: Item = { name: '需求.docx', path: '/tmp/需求.docx', kind: 'document', text: '文档正文' };
const skill: Item = { name: 'pdf', path: '/skills/pdf/SKILL.md', kind: 'skill', text: 'SKILL 内容' };

describe('输入框发送历史（↑↓ recall）', () => {
  it('追加：去首尾空白、空串跳过、连续重复去重（不误删 A,B,A）、上限截断', () => {
    expect(appendPromptHistoryEntry([], '  hello  ')).toEqual([{ text: 'hello', items: [] }]);
    expect(appendPromptHistoryEntry([], '   ')).toEqual([]);
    let entries = appendPromptHistoryEntry([], 'a');
    entries = appendPromptHistoryEntry(entries, 'b');
    entries = appendPromptHistoryEntry(entries, 'b');
    expect(entries.map(e => e.text)).toEqual(['a', 'b']); // 连续重复
    entries = appendPromptHistoryEntry(entries, 'a');
    expect(entries.map(e => e.text)).toEqual(['a', 'b', 'a']); // 非连续重复保留
    const limited = appendPromptHistoryEntry(['1', '2', '3'], '4', 3);
    expect(limited.map(e => e.text)).toEqual(['2', '3', '4']);
  });

  it('富条目：图片/文件/技能等上下文随发送完整入库（含 base64）', () => {
    const entries = appendPromptHistoryEntry([], { text: '处理这些', items: [img, doc, skill] });
    expect(entries).toHaveLength(1);
    expect(entries[0].items).toEqual([img, doc, skill]);
    expect(entries[0].items[0].image?.data).toBe('aGk=');
  });

  it('去重按完整内容：同文字不同附件不算重复', () => {
    let entries = appendPromptHistoryEntry([], { text: '看看', items: [img] });
    entries = appendPromptHistoryEntry(entries, { text: '看看', items: [] });
    expect(entries).toHaveLength(2);
    // 完全相同的重复（文字+附件）才去重
    entries = appendPromptHistoryEntry([], { text: '看看', items: [img] });
    entries = appendPromptHistoryEntry(entries, { text: '看看', items: [img] });
    expect(entries).toHaveLength(1);
  });

  it('↑：未进入历史态 → 最新一条；继续 ↑ 更旧；到最旧停在 0', () => {
    const entries = ['m1', 'm2', 'm3'];
    expect(navigatePromptHistory(entries, null, 'up')).toEqual({ nextIndex: 2, nextValue: 'm3', nextItems: [], shouldHandle: true });
    expect(navigatePromptHistory(entries, 2, 'up')).toEqual({ nextIndex: 1, nextValue: 'm2', nextItems: [], shouldHandle: true });
    expect(navigatePromptHistory(entries, 0, 'up')).toEqual({ nextIndex: 0, nextValue: 'm1', nextItems: [], shouldHandle: true });
  });

  it('↓：未进入历史态 → 最新一条；已在最新 → 退出历史态恢复空草稿', () => {
    const entries = ['m1', 'm2', 'm3'];
    expect(navigatePromptHistory(entries, null, 'down')).toEqual({ nextIndex: 2, nextValue: 'm3', nextItems: [], shouldHandle: true });
    expect(navigatePromptHistory(entries, 2, 'down')).toEqual({ nextIndex: null, nextValue: '', nextItems: [], shouldHandle: true });
    expect(navigatePromptHistory(entries, 1, 'down')).toEqual({ nextIndex: 2, nextValue: 'm3', nextItems: [], shouldHandle: true });
  });

  it('空历史不接管方向键', () => {
    expect(navigatePromptHistory([], null, 'up').shouldHandle).toBe(false);
  });

  it('recall 富条目：文字与全部附件一并返回', () => {
    const entries = [{ text: '带图提问', items: [img, skill] }, '纯文字'];
    const result = navigatePromptHistory(entries, null, 'up');
    expect(result.nextValue).toBe('纯文字');
    const rich = navigatePromptHistory(entries, result.nextIndex, 'up');
    expect(rich.nextValue).toBe('带图提问');
    expect(rich.nextItems).toEqual([img, skill]);
  });

  it('localStorage 按 workspace 隔离、归一化（截 30 条），损坏数据回空；旧版 string 条目兼容', () => {
    const store = new Map<string, string>();
    const fake = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) } as Storage;
    const entries = Array.from({ length: 35 }, (_, i) => `p${i}`);
    persistPromptHistory('/w/a', entries, fake);
    persistPromptHistory('/w/b', [{ text: '带图', items: [img] }], fake);
    expect(readPromptHistory('/w/a', fake).map(e => e.text)).toEqual(entries.slice(-30));
    expect(readPromptHistory('/w/b', fake)).toEqual([{ text: '带图', items: [img] }]);
    store.set('pi-desktop-chat-prompt-history:/w/c', '{broken');
    expect(readPromptHistory('/w/c', fake)).toEqual([]);
    // 旧版纯 string 条目照常读取（等价 items: []）
    store.set('pi-desktop-chat-prompt-history:/w/e', JSON.stringify(['old', 42, '  ', null]));
    expect(readPromptHistory('/w/e', fake)).toEqual([{ text: 'old', items: [] }]);
  });

  it('localStorage 配额超限（大图 base64）：持久化静默降级，不抛错不丢内存条目', () => {
    const failing = { getItem: () => null, setItem: () => { throw new DOMException('quota', 'QuotaExceededError'); } } as unknown as Storage;
    expect(() => persistPromptHistory('/w/q', [{ text: '大图', items: [img] }], failing)).not.toThrow();
    expect(readPromptHistory('/w/q', failing)).toEqual([]);
  });
});
