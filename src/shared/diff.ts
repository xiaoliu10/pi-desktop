import type { DiffHunk, DiffLine, FileDiff } from './types';

/**
 * LCS-based line diff. Inputs are small (single files), so an O(n*m) table is
 * fine and keeps the implementation dependency-free.
 */
export function diffLines(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = LCS length of a[i..], b[j..]
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: ' ', text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ type: '-', text: a[i++] });
    } else {
      out.push({ type: '+', text: b[j++] });
    }
  }
  while (i < n) out.push({ type: '-', text: a[i++] });
  while (j < m) out.push({ type: '+', text: b[j++] });
  return out;
}

/**
 * Collapse a flat line diff into hunks with at most `context` unchanged lines
 * around each change block.
 */
export function toHunks(lines: DiffLine[], context = 3): DiffHunk[] {
  const changed = lines.map((l) => l.type !== ' ');
  const keep = new Array<boolean>(lines.length).fill(false);
  for (let k = 0; k < lines.length; k++) {
    if (!changed[k]) continue;
    for (let d = -context; d <= context; d++) {
      const idx = k + d;
      if (idx >= 0 && idx < lines.length) keep[idx] = true;
    }
  }
  const hunks: DiffHunk[] = [];
  let cur: DiffHunk | null = null;
  let oldNo = 1;
  let newNo = 1;
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k];
    if (keep[k]) {
      if (!cur) {
        cur = { oldStart: oldNo, oldLines: 0, newStart: newNo, newLines: 0, lines: [] };
        hunks.push(cur);
      }
      cur.lines.push(line);
      if (line.type !== '-') cur.newLines++;
      if (line.type !== '+') cur.oldLines++;
    } else {
      cur = null;
    }
    if (line.type === ' ') {
      oldNo++;
      newNo++;
    } else if (line.type === '-') {
      oldNo++;
    } else {
      newNo++;
    }
  }
  return hunks;
}

export function diffTexts(oldText: string, newText: string, context = 3): DiffHunk[] {
  const a = oldText.length ? oldText.split('\n') : [];
  const b = newText.length ? newText.split('\n') : [];
  return toHunks(diffLines(a, b), context);
}

export function fileDiff(path: string, oldText: string | null, newText: string): FileDiff {
  const created = oldText === null;
  const hunks = created ? diffTexts('', newText) : diffTexts(oldText ?? '', newText);
  return { path, created, hunks };
}

export function countDiff(diff: FileDiff): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const h of diff.hunks) {
    for (const l of h.lines) {
      if (l.type === '+') additions++;
      else if (l.type === '-') deletions++;
    }
  }
  return { additions, deletions };
}
