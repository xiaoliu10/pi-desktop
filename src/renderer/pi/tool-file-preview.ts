import type { DemoDiffLine, DemoFileDiff, ToolPart } from '../replica/contracts';

/** pi edit 结果 details.diff：`-226 删行`（旧文件行号）/ ` 223 上下文` / `+45 增行`（新文件行号），
 *  `     ...` 为省略段。这是 pi 算好的真实差异，优先于 arguments 重建的朴素前后对比。 */
export function parsePiDiff(text: string): DemoFileDiff | null {
  const lines: DemoDiffLine[] = [];
  let additions = 0, deletions = 0;
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    const sign = raw[0] ?? ' ';
    const rest = raw.slice(1);
    if (rest.trim() === '...') { lines.push({ type: ' ', text: '…' }); continue; }
    const match = rest.match(/^(\d+) ?(.*)$/);
    if (sign === '-' ) {
      deletions++;
      lines.push({ type: '-', text: match ? match[2] : rest, line: match ? Number(match[1]) : undefined });
    } else if (sign === '+') {
      additions++;
      lines.push({ type: '+', text: match ? match[2] : rest, line: match ? Number(match[1]) : undefined });
    } else {
      lines.push({ type: ' ', text: match ? match[2] : rest, line: match ? Number(match[1]) : undefined });
    }
  }
  if (!lines.length) return null;
  return { path: '', created: false, additions, deletions, lines };
}

/** Completed edits preview historical inputs; pending/failed operations open the current file. */
export function toolFilePreview(part: ToolPart): {path:string; diff?:DemoFileDiff; content?:string; note:string; current?:boolean; line?:number} | null {
  if (!['read','edit','write'].includes(part.tool)) return null;
  let args: Record<string, unknown>;
  try { args = JSON.parse(part.argumentsText || '{}') || {}; } catch { return null; }
  const path = typeof args.path === 'string' ? args.path : typeof args.file_path === 'string' ? args.file_path : typeof args.filePath === 'string' ? args.filePath : '';
  if (!path) return null;
  if (part.tool === 'read') return {path, current:true, line:Number.isSafeInteger(args.offset) && Number(args.offset)>0 ? Number(args.offset) : 1, note:'正在读取文件…'};
  if (part.status !== 'done' || part.phase === 'call') return {path, current:true, note:'正在读取当前文件；本次工具修改尚未确认成功。'};
  // 已完成的编辑优先用 pi 结果里的真实 diff（自带行号）；旧记录没有时退回 arguments 重建。
  const resultDiff = (part.resultDetails as { diff?: unknown } | undefined)?.diff;
  if (typeof resultDiff === 'string') {
    const parsed = parsePiDiff(resultDiff);
    if (parsed) return { path, diff: { ...parsed, path }, note: '本次编辑的变更：红色为原内容，绿色为替换后的内容。' };
  }
  // pi 的 edit 工具：arguments = {path, edits:[{oldText,newText},…]}，一次调用可含多段替换。
  const edits = Array.isArray(args.edits) ? args.edits : undefined;
  if (edits && edits.length) {
    const lines: { type: '-' | '+'; text: string }[] = [];
    let additions = 0, deletions = 0;
    for (const e of edits) {
      if (!e || typeof e !== 'object') continue;
      const before = (e as { oldText?: unknown }).oldText, after = (e as { newText?: unknown }).newText;
      if (typeof before !== 'string' || typeof after !== 'string') continue;
      const removed = before ? before.split('\n') : [], added = after ? after.split('\n') : [];
      deletions += removed.length; additions += added.length;
      lines.push(...removed.map((text) => ({ type: '-' as const, text })));
      lines.push(...added.map((text) => ({ type: '+' as const, text })));
    }
    if (lines.length) return {path, note: `本次编辑含 ${edits.length} 段替换：红色为原内容，绿色为替换后的内容。`, diff: {path, created: false, additions, deletions, lines}};
  }
  // 兼容单段 old/new 写法（其它工具或旧记录）。
  const before = args.oldText ?? args.old_string, after = args.newText ?? args.new_string;
  if (typeof before === 'string' && typeof after === 'string') {
    const removed = before ? before.split('\n') : [], added = after ? after.split('\n') : [];
    return {path,note:'本次编辑的替换片段：红色为原内容，绿色为替换后的内容。',diff:{path,created:false,additions:added.length,deletions:removed.length,lines:[...removed.map(text=>({type:'-' as const,text})),...added.map(text=>({type:'+' as const,text}))]}};
  }
  if (typeof args.content === 'string') return {path,content:args.content,note:'本次写入的文件内容。该记录没有写入前的版本，不能展示前后差异。'};
  return null;
}
