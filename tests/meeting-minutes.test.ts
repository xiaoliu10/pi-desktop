import { describe, expect, it } from 'vitest';
import { chunkTranscript, buildMapPrompt, buildReducePrompt } from '../src/main/pi/meeting-minutes';
import type { MeetingSegment } from '../src/shared/meeting';

function segment(index: number, text: string, start = index * 300_000): MeetingSegment {
  return {
    id: `seg-${index + 1}`,
    clientSegmentId: `client-${index + 1}`,
    index,
    captureEpoch: 1,
    startOffsetMs: start,
    endOffsetMs: start + 300_000,
    wallStartedAt: '2026-11-06T09:00:00.000Z',
    wallEndedAt: '2026-11-06T09:05:00.000Z',
    mime: 'audio/wav',
    audioPath: `/tmp/seg-${index + 1}.wav`,
    bytes: 100,
    sha256: 'hash',
    status: 'done',
    failureKind: 'none',
    attempt: 1,
    text,
  };
}

describe('meeting minutes chunking', () => {
  it('按段边界分块、保留来源 ID、不丢 done 段', () => {
    const chunks = chunkTranscript([
      segment(0, 'a'.repeat(120)),
      segment(1, 'b'.repeat(120)),
    ], 200, 20);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].segmentIds).toEqual(['seg-1']);
    expect(chunks[1].segmentIds).toEqual(['seg-2']);
    expect(chunks.reduce((n, c) => n + c.text.length, 0)).toBeGreaterThanOrEqual(240);
  });

  it('相邻块带 overlap，超大单段继续拆分', () => {
    const chunks = chunkTranscript([segment(0, 'x'.repeat(500))], 200, 40);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].text.length).toBeLessThanOrEqual(200);
    expect(chunks.every(c => c.segmentIds.includes('seg-1'))).toBe(true);
  });

  it('缺失/空/失败段不进入纪要输入，但可调用方另行展示 coverage', () => {
    const failed = { ...segment(0, 'should not appear'), status: 'failed' as const, text: undefined };
    const empty = { ...segment(1, 'ignored'), status: 'empty' as const, text: '' };
    const done = segment(2, 'actual content');
    const chunks = chunkTranscript([failed, empty, done], 1000, 100);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].segmentIds).toEqual(['seg-3']);
    expect(chunks[0].text).toContain('actual content');
  });

  it('map/reduce prompt 要求引用 segmentIds 且不编造负责人', () => {
    const map = buildMapPrompt({ index: 1, total: 3, text: 'meeting text', segmentIds: ['seg-1'] });
    expect(map).toContain('seg-1');
    expect(map).toContain('owner');
    expect(map).toContain('null');
    const reduce = buildReducePrompt({
      title: '周会',
      maps: [{ chunkIndex: 1, markdown: '- topic', segmentIds: ['seg-1'] }],
      missingSegmentIds: ['seg-2'],
      missingMs: 300_000,
    });
    expect(reduce).toContain('周会');
    expect(reduce).toContain('seg-2');
    expect(reduce).toContain('300000');
  });
});
