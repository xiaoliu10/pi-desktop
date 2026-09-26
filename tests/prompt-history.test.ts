import { describe, expect, it } from 'vitest';
import {
  appendPromptHistoryEntry,
  navigatePromptHistory,
  readPromptHistory,
  persistPromptHistory,
} from '../src/renderer/replica/prompt-history';

// ZCode promptHistory/promptHistoryStorage 移植：↑↓ 回看已发送消息。
describe('输入框发送历史（↑↓ recall）', () => {
  it('追加：去首尾空白、空串跳过、连续重复去重（不误删 A,B,A）、上限截断', () => {
    expect(appendPromptHistoryEntry([], '  hello  ')).toEqual(['hello']);
    expect(appendPromptHistoryEntry([], '   ')).toEqual([]);
    let entries = ['a', 'b'];
    entries = appendPromptHistoryEntry(entries, 'b');
    expect(entries).toEqual(['a', 'b']); // 连续重复
    entries = appendPromptHistoryEntry(entries, 'a');
    expect(entries).toEqual(['a', 'b', 'a']); // 非连续重复保留
    const limited = appendPromptHistoryEntry(['1', '2', '3'], '4', 3);
    expect(limited).toEqual(['2', '3', '4']);
  });

  it('↑：未进入历史态 → 最新一条；继续 ↑ 更旧；到最旧停在 0', () => {
    const entries = ['m1', 'm2', 'm3'];
    expect(navigatePromptHistory(entries, null, 'up')).toEqual({ nextIndex: 2, nextValue: 'm3', shouldHandle: true });
    expect(navigatePromptHistory(entries, 2, 'up')).toEqual({ nextIndex: 1, nextValue: 'm2', shouldHandle: true });
    expect(navigatePromptHistory(entries, 0, 'up')).toEqual({ nextIndex: 0, nextValue: 'm1', shouldHandle: true });
  });

  it('↓：未进入历史态 → 最新一条；已在最新 → 退出历史态恢复空草稿', () => {
    const entries = ['m1', 'm2', 'm3'];
    expect(navigatePromptHistory(entries, null, 'down')).toEqual({ nextIndex: 2, nextValue: 'm3', shouldHandle: true });
    expect(navigatePromptHistory(entries, 2, 'down')).toEqual({ nextIndex: null, nextValue: '', shouldHandle: true });
    expect(navigatePromptHistory(entries, 1, 'down')).toEqual({ nextIndex: 2, nextValue: 'm3', shouldHandle: true });
  });

  it('空历史不接管方向键', () => {
    expect(navigatePromptHistory([], null, 'up').shouldHandle).toBe(false);
  });

  it('localStorage 按 workspace 隔离、归一化（截 30 条），损坏数据回空', () => {
    const store = new Map<string, string>();
    const fake = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) } as Storage;
    const entries = Array.from({ length: 35 }, (_, i) => `p${i}`);
    persistPromptHistory('/w/a', entries, fake);
    persistPromptHistory('/w/b', ['other'], fake);
    expect(readPromptHistory('/w/a', fake)).toEqual(entries.slice(-30));
    expect(readPromptHistory('/w/b', fake)).toEqual(['other']);
    store.set('pi-desktop-chat-prompt-history:/w/c', '{broken');
    expect(readPromptHistory('/w/c', fake)).toEqual([]);
    // 非字符串/空串条目被过滤
    store.set('pi-desktop-chat-prompt-history:/w/d', JSON.stringify(['ok', 42, '  ', null]));
    expect(readPromptHistory('/w/d', fake)).toEqual(['ok']);
  });
});
