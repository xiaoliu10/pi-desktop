import { describe, expect, it } from 'vitest';
import { countDiff, diffTexts, fileDiff, toHunks } from '../src/shared/diff';

describe('diffLines / diffTexts', () => {
  it('detects added, removed and kept lines', () => {
    const hunks = diffTexts('a\nb\nc\n', 'a\nB\nc\nd\n');
    const lines = hunks.flatMap((h) => h.lines);
    expect(lines.filter((l) => l.type === '-').map((l) => l.text)).toEqual(['b']);
    expect(lines.filter((l) => l.type === '+').map((l) => l.text)).toEqual(['B', 'd']);
    expect(lines.some((l) => l.type === ' ' && l.text === 'a')).toBe(true);
  });

  it('handles empty inputs', () => {
    expect(diffTexts('', '')).toEqual([]);
  });

  it('full addition when original empty', () => {
    const hunks = diffTexts('', 'x\ny');
    expect(hunks).toHaveLength(1);
    expect(hunks[0].lines.every((l) => l.type === '+')).toBe(true);
  });
});

describe('toHunks', () => {
  it('collapses distant changes into separate hunks with context', () => {
    const lines = [
      ...Array.from({ length: 20 }, (_, i) => ({ type: ' ' as const, text: `line${i}` })),
      { type: '+' as const, text: 'changed' },
      ...Array.from({ length: 20 }, (_, i) => ({ type: ' ' as const, text: `tail${i}` })),
    ];
    const hunks = toHunks(lines, 3);
    expect(hunks.length).toBe(1);
    // context 3 before + change + 3 after
    expect(hunks[0].lines.length).toBe(7);
  });
});

describe('fileDiff / countDiff', () => {
  it('marks created files and counts +/- lines', () => {
    const diff = fileDiff('a.txt', null, 'hello\nworld\n');
    expect(diff.created).toBe(true);
    const { additions, deletions } = countDiff(diff);
    expect(additions).toBe(3); // "hello", "world", trailing empty line
    expect(deletions).toBe(0);
  });

  it('computes edits against previous content', () => {
    const diff = fileDiff('a.txt', 'one\ntwo\n', 'one\nTWO\n');
    const { additions, deletions } = countDiff(diff);
    expect(additions).toBe(1);
    expect(deletions).toBe(1);
  });
});
