import { describe, expect, it } from 'vitest';
import { toolFilePreview } from '../src/renderer/pi/tool-file-preview';
import type { ToolPart } from '../src/renderer/replica/contracts';

const editPart = (edits: Array<{ oldText?: unknown; newText?: unknown }>): ToolPart => ({
  kind: 'tool', id: 't1', callId: 'c1', tool: 'edit', phase: 'result', status: 'done',
  argumentsText: JSON.stringify({ path: 'src/app.tsx', edits }),
});

describe('toolFilePreview handles pi edit {path, edits[]} array', () => {
  it('builds a clickable diff from the edits array so edited files open in the workbench', () => {
    // pi 的 edit 工具参数是 {path, edits:[{oldText,newText},…]}，不是顶层 old/new。
    const part = editPart([{ oldText: 'a\nb', newText: 'a\nB\nc' }, { oldText: 'x', newText: 'y' }]);
    const preview = toolFilePreview(part);
    expect(preview).not.toBeNull();
    expect(preview!.path).toBe('src/app.tsx');
    expect(preview!.diff).toBeDefined();
    // 两段替换的前后文本都进 diff（朴素前后对比：oldText 整段标删、newText 整段标增）
    expect(preview!.diff!.lines.filter((l) => l.type === '-').map((l) => l.text)).toEqual(['a', 'b', 'x']);
    expect(preview!.diff!.lines.filter((l) => l.type === '+').map((l) => l.text)).toEqual(['a', 'B', 'c', 'y']);
  });
  it('still returns null for a non-file tool (bash)', () => {
    const part: ToolPart = { kind: 'tool', id: 't2', callId: 'c2', tool: 'bash', phase: 'result', status: 'done', argumentsText: '{"command":"ls"}', summary: '' };
    expect(toolFilePreview(part)).toBeNull();
  });
  it('falls back to single old/new when edits array is absent', () => {
    const part: ToolPart = { kind: 'tool', id: 't3', callId: 'c3', tool: 'edit', phase: 'result', status: 'done', argumentsText: JSON.stringify({ path: 'a.ts', old_string: 'p', new_string: 'q' }), summary: '' };
    const preview = toolFilePreview(part);
    expect(preview?.diff?.lines).toEqual([{ type: '-', text: 'p' }, { type: '+', text: 'q' }]);
  });
});

describe('pi result diff (with line numbers) wins over the naive args diff', () => {
  it('parses pi details.diff rows: -226 / context 223 / +45 and elision', () => {
    const part: ToolPart = {
      kind: 'tool', id: 't4', callId: 'c4', tool: 'edit', phase: 'result', status: 'done',
      argumentsText: JSON.stringify({ path: 'src/app.tsx', oldText: 'x', newText: 'y' }),
      resultDetails: { diff: '     ...\n 222       leftSlot={\n-226           <BehaviorPill value={s.behavior} />\n+45       <section>新增</section>\n 227           {s.connecting' },
      summary: '',
    };
    const preview = toolFilePreview(part);
    expect(preview?.diff?.lines).toEqual([
      { type: ' ', text: '…' },
      { type: ' ', text: '      leftSlot={', line: 222 },
      { type: '-', text: '          <BehaviorPill value={s.behavior} />', line: 226 },
      { type: '+', text: '      <section>新增</section>', line: 45 },
      { type: ' ', text: '          {s.connecting', line: 227 },
    ]);
    expect(preview?.diff?.additions).toBe(1);
    expect(preview?.diff?.deletions).toBe(1);
    expect(preview?.path).toBe('src/app.tsx');
  });

  it('still uses the args-built diff when the result has no diff detail (old records)', () => {
    const part = editPart([{ oldText: 'a', newText: 'b' }]);
    const preview = toolFilePreview(part);
    expect(preview?.diff?.lines).toEqual([{ type: '-', text: 'a' }, { type: '+', text: 'b' }]);
  });
});

describe('parseUnifiedDiff carries git hunk line numbers', async () => {
  const { parseUnifiedDiff } = await import('../src/renderer/pi/adapter');
  it('numbers del rows with old-file lines and add/context rows with new-file lines', () => {
    const diff = parseUnifiedDiff([
      'diff --git a/src/app.ts b/src/app.ts',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -12,3 +12,3 @@ function x() {',
      ' const a = 1;',
      '-const b = 2;',
      '+const b = 22;',
      ' return a + b;',
    ].join('\n'));
    expect(diff[0]?.lines).toEqual([
      { type: ' ', text: 'const a = 1;', line: 12 },
      { type: '-', text: 'const b = 2;', line: 13 },
      { type: '+', text: 'const b = 22;', line: 13 },
      { type: ' ', text: 'return a + b;', line: 14 },
    ]);
  });
});
