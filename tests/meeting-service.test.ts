import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MeetingService, classifySegmentFailure } from '../src/main/pi/meeting-service';
import { MEETING_MAX_BYTES } from '../src/shared/meeting';

type TranscribeCall = { bytes: Uint8Array; mime: string };

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pi-desktop-meeting-'));
}

function wavLike(text: string): Uint8Array {
  return new TextEncoder().encode(`wav:${text}`);
}

function segmentInput(overrides: Partial<Parameters<MeetingService['appendSegment']>[2]> = {}) {
  const now = new Date('2026-11-06T09:00:00.000Z');
  return {
    clientSegmentId: 'client-seg-1',
    captureEpoch: 1,
    startOffsetMs: 0,
    endOffsetMs: 300_000,
    wallStartedAt: now.toISOString(),
    wallEndedAt: new Date(now.getTime() + 300_000).toISOString(),
    mime: 'audio/wav',
    ...overrides,
  };
}

describe('MeetingService', () => {
  let root: string;
  beforeEach(() => { root = tmpRoot(); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('先落盘再转写，重复 clientSegmentId 幂等且不重复写音频', async () => {
    const calls: TranscribeCall[] = [];
    let release: ((text: string) => void) | undefined;
    const gate = new Promise<string>(resolve => { release = resolve; });
    const meeting = new MeetingService(() => root, {
      transcribe: async (bytes, mime) => {
        calls.push({ bytes, mime });
        return await gate;
      },
      retryDelayMs: 1,
    });
    const created = meeting.create({ title: '周会' });
    const first = await meeting.appendSegment(created.id, wavLike('first'), segmentInput());
    expect(first.duplicated).toBe(false);
    expect(first.segment.status).toBe('transcribing');

    const duplicate = await meeting.appendSegment(created.id, wavLike('first'), segmentInput());
    expect(duplicate.duplicated).toBe(true);
    expect(duplicate.segment.id).toBe(first.segment.id);
    expect(calls).toHaveLength(1);

    release?.('讨论了发布窗口');
    await meeting.waitForIdle(created.id);
    const updated = meeting.get(created.id);
    expect(updated.segments).toHaveLength(1);
    expect(updated.segments[0]).toMatchObject({ status: 'done', text: '讨论了发布窗口' });
    expect(updated.coverage).toEqual({ capturedMs: 300_000, transcribedMs: 300_000, emptyMs: 0, missingMs: 0 });
    expect(fs.readdirSync(path.join(root, 'meetings', created.id, 'audio'))).toHaveLength(1);
    expect(fs.readFileSync(path.join(root, 'meetings', created.id, 'transcripts', 'transcript.jsonl'), 'utf8')).toContain('讨论了发布窗口');
  });

  it('空转写标为 empty；终态覆盖 emptyMs 而不是 missingMs', async () => {
    const meeting = new MeetingService(() => root, {
      transcribe: async () => ({ text: '   ' }),
      retryDelayMs: 1,
    });
    const created = meeting.create({});
    await meeting.appendSegment(created.id, wavLike('silence'), segmentInput({ clientSegmentId: 'quiet' }));
    await meeting.waitForIdle(created.id);
    const updated = meeting.get(created.id);
    expect(updated.segments[0].status).toBe('empty');
    expect(updated.coverage).toEqual({ capturedMs: 300_000, transcribedMs: 0, emptyMs: 300_000, missingMs: 0 });
  });

  it('transient 超时按预算重试；成功只提交一次', async () => {
    let attempts = 0;
    const meeting = new MeetingService(() => root, {
      transcribe: async () => {
        attempts++;
        if (attempts === 1) {
          const error = new Error('转写超时') as Error & { kind: 'timeout' };
          error.kind = 'timeout';
          throw error;
        }
        return { text: '第二次成功' };
      },
      retryDelayMs: 1,
    });
    const created = meeting.create({});
    await meeting.appendSegment(created.id, wavLike('retry'), segmentInput({ clientSegmentId: 'retry' }));
    await meeting.waitForIdle(created.id);
    const updated = meeting.get(created.id);
    expect(attempts).toBe(2);
    expect(updated.segments[0]).toMatchObject({ status: 'done', text: '第二次成功', attempt: 2 });
    expect(fs.readFileSync(path.join(root, 'meetings', created.id, 'transcripts', 'transcript.jsonl'), 'utf8')).toContain('第二次成功');
  });

  it('auth 失败不自动重试，标为 failed 并计入 missing', async () => {
    let attempts = 0;
    const meeting = new MeetingService(() => root, {
      transcribe: async () => {
        attempts++;
        const error = new Error('转写服务返回 401') as Error & { kind: 'auth' };
        error.kind = 'auth';
        throw error;
      },
      retryDelayMs: 1,
    });
    const created = meeting.create({});
    await meeting.appendSegment(created.id, wavLike('denied'), segmentInput({ clientSegmentId: 'denied' }));
    await meeting.waitForIdle(created.id);
    const updated = meeting.get(created.id);
    expect(attempts).toBe(1);
    expect(updated.segments[0]).toMatchObject({ status: 'failed', failureKind: 'auth' });
    expect(updated.coverage.missingMs).toBe(300_000);
    expect(updated.status).toBe('recording');
  });

  it('停止进入 processing；终态 missing 段保留音频并可手动重试', async () => {
    const meeting = new MeetingService(() => root, {
      transcribe: async () => {
        const error = new Error('network down') as Error & { kind: 'network' };
        error.kind = 'network';
        throw error;
      },
      retryDelayMs: 1,
      retryBudgetMs: 20,
    });
    const created = meeting.create({});
    await meeting.appendSegment(created.id, wavLike('offline'), segmentInput({ clientSegmentId: 'offline' }));
    await meeting.waitForIdle(created.id);
    const stopped = meeting.stop(created.id);
    expect(stopped.status).toBe('processing');
    expect(fs.existsSync(stopped.segments[0].audioPath)).toBe(true);
    for (let i = 0; i < 200 && meeting.get(created.id).segments[0].status !== 'missing'; i++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const final = meeting.get(created.id);
    expect(final.segments[0].status).toBe('missing');
    const retrying = meeting.retrySegment(created.id, final.segments[0].id);
    expect(retrying.segments[0].status).toBe('transcribing');
    expect(fs.existsSync(retrying.segments[0].audioPath)).toBe(true);
  });

  it('拒绝空音频、超大音频和坏 meta', async () => {
    const meeting = new MeetingService(() => root, { transcribe: async () => ({ text: 'x' }), retryDelayMs: 1 });
    const created = meeting.create({});
    await expect(meeting.appendSegment(created.id, new Uint8Array(), segmentInput())).rejects.toThrow(/为空/);
    const huge = new Uint8Array(MEETING_MAX_BYTES + 1);
    await expect(meeting.appendSegment(created.id, huge, segmentInput({ clientSegmentId: 'huge' }))).rejects.toThrow(/上限/);
    await expect(meeting.appendSegment(created.id, wavLike('bad'), segmentInput({ clientSegmentId: '' }))).rejects.toThrow(/segment/i);
    await expect(meeting.appendSegment(created.id, wavLike('bad'), segmentInput({ clientSegmentId: 'bad-time', startOffsetMs: 400, endOffsetMs: 300 }))).rejects.toThrow(/时间/);
  });

  it('纪要 map-reduce 保存分段摘要与最终 Markdown，状态回 ready', async () => {
    const calls: Array<{ phase: string; prompt: string }> = [];
    const meeting = new MeetingService(() => root, {
      transcribe: async () => '讨论了发版窗口',
      retryDelayMs: 1,
      minutesCall: async input => {
        calls.push({ phase: input.phase, prompt: input.prompt });
        return input.phase === 'map'
          ? '- Action Item: owner: null (segments: seg-000001-xxxxxxxx)'
          : '# 纪要\n- 未明确';
      },
    });
    const created = meeting.create({ title: '纪要会议' });
    await meeting.appendSegment(created.id, wavLike('minutes'), segmentInput({ clientSegmentId: 'minutes' }));
    await meeting.waitForIdle(created.id);
    meeting.stop(created.id);
    const started = meeting.startMinutes(created.id, { provider: 'openai', model: 'gpt-test' });
    expect(started.minutes.status).toBe('running');
    for (let i = 0; i < 50 && meeting.get(created.id).minutes.status === 'running'; i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const done = meeting.get(created.id);
    expect(done.minutes).toMatchObject({ status: 'done', provider: 'openai', model: 'gpt-test', mappedChunks: 1, completedChunks: 1 });
    expect(done.status).toBe('ready');
    expect(calls.map(c => c.phase)).toEqual(['map', 'reduce']);
    expect(calls[0].prompt).toContain('owner');
    expect(calls[1].prompt).toContain('纪要会议');
    expect(fs.readFileSync(path.join(root, 'meetings', created.id, 'minutes', 'map-0001.md'), 'utf8')).toContain('owner: null');
    expect(fs.readFileSync(path.join(root, 'meetings', created.id, 'minutes', 'minutes.md'), 'utf8')).toContain('# 纪要');
  });

  it('IPC 返回与事件快照可 structuredClone，不携带内部 Promise/Timer', async () => {
    let release: ((text: string) => void) | undefined;
    const gate = new Promise<string>(resolve => { release = resolve; });
    let emitted: unknown;
    const meeting = new MeetingService(() => root, {
      transcribe: async () => gate,
      retryDelayMs: 1,
      onChange: value => { emitted = value; },
    });
    const created = meeting.create({});
    await meeting.appendSegment(created.id, wavLike('clone'), segmentInput({ clientSegmentId: 'cloneable' }));
    expect(() => structuredClone(meeting.get(created.id))).not.toThrow();
    expect(() => structuredClone(emitted)).not.toThrow();
    expect(JSON.stringify(emitted)).not.toContain('inflight');
    release?.('ok');
    await meeting.waitForIdle(created.id);
  });

  it('应用重启后把残留 recording/transcribing 恢复为 processing 并重排队列', async () => {
    let release: ((text: string) => void) | undefined;
    const gate = new Promise<string>(resolve => { release = resolve; });
    const first = new MeetingService(() => root, { transcribe: async () => gate, retryDelayMs: 1 });
    const created = first.create({ title: '重启' });
    await first.appendSegment(created.id, wavLike('recover'), segmentInput({ clientSegmentId: 'restart-seg' }));
    const resumed = new MeetingService(() => root, { transcribe: async () => '恢复转写', retryDelayMs: 1 });
    const loaded = resumed.get(created.id);
    expect(loaded.status).toBe('processing');
    await resumed.waitForIdle(created.id);
    for (let i = 0; i < 50 && resumed.get(created.id).status !== 'ready'; i++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(resumed.get(created.id)).toMatchObject({ status: 'ready' });
    expect(resumed.get(created.id).segments[0]).toMatchObject({ status: 'done', text: '恢复转写' });
    release?.('旧任务不再等待');
  });

  it('仍有分段转写中时拒绝生成纪要；全部结算后才生成', async () => {
    const calls: Array<{ phase: string }> = [];
    let release: ((text: string) => void) | undefined;
    const gate = new Promise<string>(resolve => { release = resolve; });
    let attempts = 0;
    const meeting = new MeetingService(() => root, {
      transcribe: async () => {
        attempts++;
        return attempts === 1 ? gate : 'b'.repeat(23_000);
      },
      retryDelayMs: 1,
      minutesCall: async input => { calls.push({ phase: input.phase }); return 'minutes'; },
    });
    const created = meeting.create({ title: '活动纪要' });
    await meeting.appendSegment(created.id, wavLike('one'), segmentInput({ clientSegmentId: 'active-minutes-1' }));
    await meeting.appendSegment(created.id, wavLike('two'), segmentInput({ clientSegmentId: 'active-minutes-2', startOffsetMs: 300_000, endOffsetMs: 600_000 }));
    meeting.stop(created.id);
    expect(() => meeting.startMinutes(created.id, { provider: 'openai', model: 'gpt-test' })).toThrow(/转写/);
    release?.('a'.repeat(23_000));
    await meeting.waitForIdle(created.id);
    for (let i = 0; i < 50 && meeting.get(created.id).status !== 'ready'; i++) await new Promise(resolve => setTimeout(resolve, 5));
    meeting.startMinutes(created.id, { provider: 'openai', model: 'gpt-test' });
    for (let i = 0; i < 100 && meeting.get(created.id).minutes.status !== 'done'; i++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(calls.map(c => c.phase)).toEqual(['map', 'map', 'reduce']);
  });

  it('active/queued 分段不能并发手动重试', async () => {
    let release: ((text: string) => void) | undefined;
    const gate = new Promise<string>(resolve => { release = resolve; });
    let attempts = 0;
    const meeting = new MeetingService(() => root, {
      transcribe: async () => { attempts++; return gate; }, retryDelayMs: 1,
    });
    const created = meeting.create({});
    const ack = await meeting.appendSegment(created.id, wavLike('busy'), segmentInput({ clientSegmentId: 'busy-retry' }));
    expect(() => meeting.retrySegment(created.id, ack.segment.id)).toThrow(/正在转写/);
    release?.('only once');
    await meeting.waitForIdle(created.id);
    expect(attempts).toBe(1);
    expect(meeting.get(created.id).segments[0].status).toBe('done');
  });

  it('重试预算过期后不再发起新一次转写请求', async () => {
    let attempts = 0;
    const meeting = new MeetingService(() => root, {
      transcribe: async () => { attempts++; const error = new Error('network down') as Error & { kind: 'network' }; error.kind = 'network'; throw error; },
      retryDelayMs: 40,
      retryBudgetMs: 20,
    });
    const created = meeting.create({});
    await meeting.appendSegment(created.id, wavLike('budget'), segmentInput({ clientSegmentId: 'budget-seg' }));
    await meeting.waitForIdle(created.id);
    await new Promise(resolve => setTimeout(resolve, 80));
    await meeting.waitForIdle(created.id);
    expect(attempts).toBe(1);
    expect(meeting.get(created.id).segments[0]).toMatchObject({ status: 'failed', failureKind: 'timeout' });
  });

  it('classifySegmentFailure 区分 transient 与 terminal', () => {
    expect(classifySegmentFailure({ kind: 'rate_limited' })).toBe('rate_limited');
    expect(classifySegmentFailure(new Error('fetch failed: ECONNRESET'))).toBe('network');
    expect(classifySegmentFailure(new Error('转写服务返回 429'))).toBe('rate_limited');
    expect(classifySegmentFailure(new Error('转写服务返回 401'))).toBe('auth');
    expect(classifySegmentFailure(new Error('录音超过 24 MiB 上限'))).toBe('too_large');
    expect(classifySegmentFailure(new Error('unknown provider boom'))).toBe('provider');
  });
});
