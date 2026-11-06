import type { MeetingSegment } from '../../shared/meeting';

export interface MeetingTranscriptChunk {
  index: number;
  text: string;
  segmentIds: string[];
  startOffsetMs: number;
  endOffsetMs: number;
}

/**
 * 按段边界分块。done 段是唯一纪要输入；超大段继续拆，相邻块保留 overlap。
 * transcript 没有可靠句子边界，段是最小单元；这里绝不丢掉 done 段。
 */
export function chunkTranscript(
  segments: MeetingSegment[],
  maxChars = 24_000,
  overlapChars = 1_000,
): MeetingTranscriptChunk[] {
  if (!Number.isFinite(maxChars) || maxChars < 200) throw new Error('纪要分块大小无效');
  if (!Number.isFinite(overlapChars) || overlapChars < 0 || overlapChars >= maxChars) throw new Error('纪要 overlap 无效');
  const usable = segments
    .filter(s => s.status === 'done' && typeof s.text === 'string' && s.text.trim())
    .sort((a, b) => a.index - b.index);
  const chunks: MeetingTranscriptChunk[] = [];
  let current: MeetingTranscriptChunk | undefined;

  const push = (text: string, segmentIds: string[], start: number, end: number) => {
    const clean = text.trim();
    if (!clean) return;
    if (current && current.text.length + clean.length + 2 <= maxChars) {
      current.text += '\n\n' + clean;
      for (const id of segmentIds) if (!current.segmentIds.includes(id)) current.segmentIds.push(id);
      current.startOffsetMs = Math.min(current.startOffsetMs, start);
      current.endOffsetMs = Math.max(current.endOffsetMs, end);
      return;
    }
    if (current) chunks.push(current);
    current = {
      index: chunks.length,
      text: clean,
      segmentIds: [...segmentIds],
      startOffsetMs: start,
      endOffsetMs: end,
    };
  };

  for (const segment of usable) {
    const text = segment.text!.trim();
    if (text.length <= maxChars) {
      const tail = current?.text.slice(-overlapChars) ?? '';
      const candidate = tail ? `${tail}\n\n${text}` : text;
      push(candidate, [segment.id], segment.startOffsetMs, segment.endOffsetMs);
      continue;
    }
    // 超大段按 maxChars-overlap 步进拆，每片前带 overlap；所有片共享段 ID。
    const step = maxChars - overlapChars;
    let offset = 0;
    while (offset < text.length) {
      const pieceStart = Math.max(0, offset - overlapChars);
      const pieceEnd = Math.min(text.length, offset + step);
      const piece = (offset > 0 ? text.slice(pieceStart, offset) + '\n\n' : '') + text.slice(offset, pieceEnd);
      push(piece, [segment.id], segment.startOffsetMs, segment.endOffsetMs);
      offset = pieceEnd;
    }
  }
  if (current) chunks.push(current);
  return chunks.map((chunk, index) => ({ ...chunk, index }));
}

export function buildMapPrompt(chunk: MeetingTranscriptChunk): string {
  return [
    `你是会议纪要抽取器。下面是第 ${chunk.index + 1} 块会议转写，来源 segmentIds：${chunk.segmentIds.join(', ')}。`,
    '',
    '请只基于这段原文输出 Markdown，不要补写没有说过的内容。包含以下小节：',
    '- 讨论要点',
    '- 决议',
    '- Action Items（每条必须包含 owner 字段说明；原文没有负责人时写 owner: null，不要猜人名）',
    '- 待澄清 / 风险',
    '',
    '引用事实时在行末加 `(segments: seg-id)`；没有依据的内容不要输出。',
    '',
    '会议转写：',
    chunk.text,
  ].join('\n');
}

export function buildReducePrompt(input: {
  title: string;
  maps: Array<{ chunkIndex: number; markdown: string; segmentIds: string[] }>;
  missingSegmentIds: string[];
  missingMs: number;
}): string {
  const maps = input.maps.map(m => [
    `## 第 ${m.chunkIndex + 1} 块摘要（segments: ${m.segmentIds.join(', ')}）`,
    m.markdown,
  ].join('\n')).join('\n\n---\n\n');
  const missing = input.missingSegmentIds.length
    ? `以下段没有可用转写，必须在「待澄清」中明确列出缺失范围，不要臆测内容：${input.missingSegmentIds.join(', ')}；缺失音频 ${input.missingMs} ms。`
    : `本次没有缺失转写段；缺失音频 ${input.missingMs} ms。`;
  return [
    `请把会议《${input.title}》的分块抽取结果合并成一份最终中文会议纪要。`,
    '只使用这些抽取结果和其中的 segment 引用；不要编造负责人、日期或“一致同意”。原文缺失时写“未明确”。',
    missing,
    '',
    '输出结构：',
    '# 会议纪要：' + input.title,
    '## 速览',
    '## 决议',
    '## Action Items',
    '## 待澄清 / 风险',
    '## 详细讨论',
    '',
    maps,
  ].join('\n');
}

export function extractAssistantText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content.map(block => {
    const item = block as { type?: unknown; text?: unknown };
    return item?.type === 'text' && typeof item.text === 'string' ? item.text : '';
  }).join('').trim();
}
