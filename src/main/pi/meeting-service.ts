import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type {
  Meeting, MeetingCoverage, MeetingMinutesInput, MeetingSegment, MeetingSegmentAck,
  MeetingSegmentInput, MeetingStatus, SegmentFailureKind, SegmentStatus,
} from '../../shared/meeting';
import { MEETING_CONCURRENCY, MEETING_MAX_BYTES, MEETING_MAX_SEGMENT_MS, MEETING_RETRY_BUDGET_MS } from '../../shared/meeting';
import { buildMapPrompt, buildReducePrompt, chunkTranscript } from './meeting-minutes';

/** main 内部注入；生产走 VoiceService，测试用同步/受控 promise。 */
export type MeetingTranscriber = (
  bytes: Uint8Array,
  mime: string,
  options: { timeoutMs: number },
) => Promise<{ text: string } | string>;

export interface MeetingServiceOptions {
  transcribe: MeetingTranscriber;
  concurrency?: number;
  retryDelayMs?: number;
  retryBudgetMs?: number;
  onChange?: (meeting: Meeting) => void;
  power?: {
    acquire?: () => void;
    release?: () => void;
  };
  minutesCall?: (input: {
    phase: 'map' | 'reduce';
    prompt: string;
    provider: string;
    model: string;
    timeoutMs: number;
  }) => Promise<string>;
}

interface MeetingInternal extends Meeting {
  // schedule bookkeeping 不进 IPC/manifest。
  timers?: Set<NodeJS.Timeout>;
  inflight?: Set<Promise<void>>;
}

const TRANSIENT: ReadonlySet<SegmentFailureKind> = new Set(['network', 'rate_limited', 'timeout', 'provider']);
const SEGMENT_ID_RE = /^[A-Za-z0-9_.-]{4,120}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/** typed error 优先；文本兜底只作为最后防线，provider 新错误形态必须优先结构化。 */
export function classifySegmentFailure(error: unknown): SegmentFailureKind {
  const typed = error as { kind?: unknown; status?: unknown; code?: unknown };
  const kind = typed?.kind;
  if (kind === 'network' || kind === 'rate_limited' || kind === 'provider' || kind === 'auth'
    || kind === 'bad_request' || kind === 'too_large' || kind === 'timeout') return kind;
  if (typed?.status === 401 || typed?.status === 403) return 'auth';
  if (typed?.status === 429) return 'rate_limited';
  if (typed?.status === 413) return 'too_large';
  if (typeof typed?.code === 'string' && ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT'].includes(typed.code)) return 'network';
  const text = String((error as Error)?.message ?? error);
  if (/网络|network|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(text)) return 'network';
  if (/429|rate limit|限流/i.test(text)) return 'rate_limited';
  if (/超时|timeout|timed out/i.test(text)) return 'timeout';
  if (/401|403|unauthorized|forbidden|API key/i.test(text)) return 'auth';
  if (/400|bad request|不支持|invalid/i.test(text)) return 'bad_request';
  if (/24 MiB|太大|too large|413/i.test(text)) return 'too_large';
  return 'provider';
}

function nowIso(): string { return new Date().toISOString(); }
function durationMs(segment: MeetingSegmentInput): number { return segment.endOffsetMs - segment.startOffsetMs; }

function normalizeStatus(value: unknown): MeetingStatus {
  return value === 'recording' || value === 'paused' || value === 'processing' || value === 'ready' || value === 'failed'
    ? value : 'ready';
}

function parseMeeting(raw: string): MeetingInternal {
  const value = JSON.parse(raw) as MeetingInternal;
  if (!value || value.version !== 1 || typeof value.id !== 'string' || !Array.isArray(value.segments)) throw new Error('meeting manifest 无效');
  value.status = normalizeStatus(value.status);
  if (value.minutes?.status === 'running') {
    // 应用重启/崩溃后不可能还有 worker 在跑；保留分段与已有 map，用户可重新生成。
    value.minutes = { ...value.minutes, status: 'failed', error: '应用重启，纪要生成已中断，可重新生成' };
  }
  value.captureEpochs ??= [];
  value.coverage ??= { capturedMs: 0, transcribedMs: 0, emptyMs: 0, missingMs: 0 };
  value.minutes ??= { status: 'idle' };
  return value;
}

/** IPC/事件只能拿可 structuredClone 的纯数据；timers/inflight 是调度私有。 */
function snapshot(meeting: MeetingInternal): Meeting {
  const copy = {
    ...meeting,
    segments: meeting.segments.map(segment => ({ ...segment })),
    captureEpochs: meeting.captureEpochs.map(epoch => ({ ...epoch })),
    coverage: { ...meeting.coverage },
    minutes: { ...meeting.minutes },
  } as Meeting & Partial<Pick<MeetingInternal, 'timers' | 'inflight'>>;
  delete copy.timers;
  delete copy.inflight;
  return copy;
}

export class MeetingService {
  private index = new Map<string, MeetingInternal>();
  private indexLoaded = false;
  private queue = new Map<string, string[]>();
  private active = new Map<string, Set<string>>();
  /** transient 重试预算按整段累计：从第一次失败开始计时，不是每次失败重置。 */
  private retryStart = new Map<string, number>();

  constructor(private rootFn: () => string, private options: MeetingServiceOptions) {}

  private get root(): string {
    const root = this.rootFn();
    if (typeof root !== 'string' || !root) throw new Error('应用数据目录不可用');
    return path.join(root, 'meetings');
  }

  private meetingFile(id: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,80}$/.test(id)) throw new Error('会议 ID 无效');
    return path.join(this.root, id, 'meeting.json');
  }

  private loadIndex(): void {
    if (this.indexLoaded) return;
    fsSync.mkdirSync(this.root, { recursive: true });
    for (const entry of fsSync.readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(this.root, entry.name, 'meeting.json');
      try {
        const meeting = parseMeeting(fsSync.readFileSync(file, 'utf8'));
        meeting.timers = new Set();
        meeting.inflight = new Set();
        this.index.set(meeting.id, meeting);
      } catch { /* 损坏目录不影响应用启动与其他会议 */ }
    }
    this.indexLoaded = true;
    this.recoverInterruptedMeetings();
  }

  /** 应用崩溃/重启后 recorder 已不存在：不能留下 recording/transcribing 假状态，也不能丢已落盘音频。 */
  private recoverInterruptedMeetings(): void {
    for (const meeting of this.index.values()) {
      if (meeting.status !== 'recording' && meeting.status !== 'paused') continue;
      meeting.status = 'processing';
      const last = meeting.captureEpochs[meeting.captureEpochs.length - 1];
      if (last && !last.endedAt) last.endedAt = nowIso();
      meeting.captureEpochs.push({ epoch: meeting.captureEpochs.length + 1, startedAt: nowIso(), reason: 'error' });
      for (const segment of meeting.segments) {
        if (['queued', 'transcribing'].includes(segment.status)
          || (segment.status === 'failed' && TRANSIENT.has(segment.failureKind))) this.enqueue(meeting.id, segment.id);
      }
      this.persist(meeting);
      this.pump(meeting.id);
    }
  }

  private persist(meeting: MeetingInternal): void {
    const dir = path.join(this.root, meeting.id);
    fsSync.mkdirSync(dir, { recursive: true });
    meeting.updatedAt = nowIso();
    const file = path.join(dir, 'meeting.json');
    const tmp = `${file}.${randomUUID()}.tmp`;
    fsSync.writeFileSync(tmp, JSON.stringify(meeting, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fsSync.renameSync(tmp, file);
    this.options.onChange?.(snapshot(meeting));
  }

  private recomputeCoverage(meeting: MeetingInternal): void {
    const coverage: MeetingCoverage = { capturedMs: 0, transcribedMs: 0, emptyMs: 0, missingMs: 0 };
    for (const segment of meeting.segments) {
      const ms = segment.endOffsetMs - segment.startOffsetMs;
      coverage.capturedMs += ms;
      if (segment.status === 'done') coverage.transcribedMs += ms;
      else if (segment.status === 'empty') coverage.emptyMs += ms;
      else if (['failed', 'missing'].includes(segment.status)) coverage.missingMs += ms;
    }
    meeting.coverage = coverage;
  }

  private rewriteTranscript(meeting: MeetingInternal): void {
    const dir = path.join(this.root, meeting.id, 'transcripts');
    fsSync.mkdirSync(dir, { recursive: true });
    const rows = [...meeting.segments]
      .filter(s => s.status === 'done' && s.text)
      .sort((a, b) => a.index - b.index)
      .map(s => JSON.stringify({
        id: s.id, clientSegmentId: s.clientSegmentId, index: s.index,
        startOffsetMs: s.startOffsetMs, endOffsetMs: s.endOffsetMs,
        wallStartedAt: s.wallStartedAt, wallEndedAt: s.wallEndedAt, text: s.text,
      }));
    const file = path.join(dir, 'transcript.jsonl');
    const tmp = `${file}.tmp`;
    fsSync.writeFileSync(tmp, (rows.length ? rows.join('\n') + '\n' : ''), { flag: 'wx' });
    fsSync.renameSync(tmp, file);
  }

  create(input: { title?: string }): Meeting {
    this.loadIndex();
    const id = `mtg-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const startedAt = nowIso();
    const meeting: MeetingInternal = {
      version: 1,
      id,
      title: (input.title || '').trim().slice(0, 120) || `会议 ${new Date().toLocaleString()}`,
      createdAt: startedAt,
      updatedAt: startedAt,
      status: 'recording',
      captureEpochs: [{ epoch: 1, startedAt, reason: 'start' }],
      segments: [],
      coverage: { capturedMs: 0, transcribedMs: 0, emptyMs: 0, missingMs: 0 },
      minutes: { status: 'idle' },
      timers: new Set(),
      inflight: new Set(),
    };
    this.index.set(id, meeting);
    this.persist(meeting);
    this.options.power?.acquire?.();
    return snapshot(meeting);
  }

  list() {
    this.loadIndex();
    return [...this.index.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(snapshot);
  }

  get(id: string): Meeting {
    this.loadIndex();
    const meeting = this.index.get(id);
    if (!meeting) throw new Error('会议不存在');
    return snapshot(meeting);
  }

  private require(id: string): MeetingInternal {
    this.loadIndex();
    const meeting = this.index.get(id);
    if (!meeting) throw new Error('会议不存在');
    return meeting;
  }

  private setSegment(meeting: MeetingInternal, segment: MeetingSegment): void {
    meeting.segments[segment.index] = segment;
    this.recomputeCoverage(meeting);
    this.rewriteTranscript(meeting);
    this.persist(meeting);
  }

  async appendSegment(id: string, bytes: Uint8Array, input: MeetingSegmentInput): Promise<MeetingSegmentAck> {
    const meeting = this.require(id);
    if (meeting.status !== 'recording' && meeting.status !== 'paused') throw new Error('会议已停止，不能追加分段');
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) throw new Error('录音数据为空');
    if (bytes.byteLength > MEETING_MAX_BYTES) throw new Error(`录音段超过 ${Math.floor(MEETING_MAX_BYTES / 1024 / 1024)} MiB 上限，请缩短分段`);
    if (typeof input.clientSegmentId !== 'string' || !SEGMENT_ID_RE.test(input.clientSegmentId)) throw new Error('segment id 无效');
    if (!Number.isFinite(input.captureEpoch) || input.captureEpoch < 1) throw new Error('capture epoch 无效');
    if (!Number.isFinite(input.startOffsetMs) || !Number.isFinite(input.endOffsetMs)
      || input.startOffsetMs < 0 || durationMs(input) <= 0 || durationMs(input) > MEETING_MAX_SEGMENT_MS) throw new Error('分段时间无效');
    if (!ISO_RE.test(input.wallStartedAt) || !ISO_RE.test(input.wallEndedAt)) throw new Error('分段 wall clock 无效');
    if (input.mime !== 'audio/wav' && input.mime !== 'audio/webm' && input.mime !== 'audio/mp4') throw new Error('音频类型无效');

    const duplicate = meeting.segments.find(s => s.clientSegmentId === input.clientSegmentId);
    if (duplicate) return { meeting: { ...meeting }, segment: { ...duplicate }, duplicated: true };

    const dir = path.join(this.root, id, 'audio');
    fsSync.mkdirSync(dir, { recursive: true });
    const ext = input.mime === 'audio/wav' ? 'wav' : input.mime === 'audio/mp4' ? 'm4a' : 'webm';
    const index = meeting.segments.length;
    const serverId = `seg-${String(index + 1).padStart(6, '0')}-${randomUUID().slice(0, 8)}`;
    const relative = path.join('audio', `${serverId}.${ext}`);
    const absolute = path.join(this.root, id, relative);
    const payload = Buffer.from(bytes);
    const tmp = `${absolute}.tmp`;
    fsSync.writeFileSync(tmp, payload, { flag: 'wx', mode: 0o600 });
    fsSync.renameSync(tmp, absolute);
    const segment: MeetingSegment = {
      ...input,
      id: serverId,
      index,
      audioPath: absolute,
      bytes: payload.byteLength,
      sha256: createHash('sha256').update(payload).digest('hex'),
      status: 'queued',
      failureKind: 'none',
      attempt: 0,
    };
    this.setSegment(meeting, segment);
    this.enqueue(id, segment.id);
    return { meeting: { ...meeting }, segment: { ...segment }, duplicated: false };
  }

  private enqueue(id: string, segmentId: string): void {
    if (this.active.get(id)?.has(segmentId)) return;
    const queue = this.queue.get(id) ?? [];
    if (!queue.includes(segmentId)) queue.push(segmentId);
    this.queue.set(id, queue);
    this.pump(id);
  }

  private pump(id: string): void {
    const meeting = this.require(id);
    const queue = this.queue.get(id) ?? [];
    const activeSet = this.active.get(id) ?? new Set<string>();
    const active = activeSet.size;
    if (!queue.length || active >= (this.options.concurrency ?? MEETING_CONCURRENCY)) {
      if (!queue.length && !active && !(meeting.timers?.size) && meeting.status === 'processing') this.finishProcessing(id);
      return;
    }
    const segmentId = queue.shift()!;
    this.queue.set(id, queue);
    activeSet.add(segmentId);
    this.active.set(id, activeSet);
    const task = this.transcribeById(id, segmentId).finally(() => {
      activeSet.delete(segmentId);
      if (!activeSet.size) this.active.delete(id);
      if (meeting.timers?.size) return; // retry scheduled; pump again when timer fires
      this.pump(id);
    });
    meeting.inflight?.add(task);
    void task.catch(() => undefined).finally(() => meeting.inflight?.delete(task));
    this.pump(id);
  }

  private scheduleRetry(id: string, segmentId: string, delayMs: number): void {
    const meeting = this.require(id);
    const timer = setTimeout(() => {
      meeting.timers?.delete(timer);
      this.enqueue(id, segmentId);
    }, Math.max(0, delayMs));
    timer.unref?.();
    meeting.timers?.add(timer);
  }

  private async transcribeById(id: string, segmentId: string): Promise<void> {
    const meeting = this.require(id);
    const segment = meeting.segments.find(s => s.id === segmentId);
    if (!segment || ['done', 'empty'].includes(segment.status)) return;
    const startedAt = Date.now();
    const retryBudgetMs = this.options.retryBudgetMs ?? MEETING_RETRY_BUDGET_MS;
    if (!this.retryStart.has(segmentId)) this.retryStart.set(segmentId, startedAt);
    const elapsedBeforeRequest = Date.now() - this.retryStart.get(segmentId)!;
    if (elapsedBeforeRequest >= retryBudgetMs) {
      segment.status = 'failed';
      segment.failureKind = 'timeout';
      segment.error = '转写重试预算已用尽';
      this.retryStart.delete(segmentId);
      this.setSegment(meeting, segment);
      return;
    }
    const naturalTimeoutMs = Math.min(
      240_000,
      Math.max(60_000, 30_000 + ((segment.endOffsetMs - segment.startOffsetMs) / 1000) * 2000 + segment.bytes / (16 * 1024) * 1000),
    );
    // 重试请求被预算截止；首次请求允许自然超时，失败后不再超过预算重试。
    const timeoutMs = segment.attempt > 0
      ? Math.max(1_000, Math.min(naturalTimeoutMs, retryBudgetMs - elapsedBeforeRequest))
      : naturalTimeoutMs;
    segment.status = 'transcribing';
    segment.attempt += 1;
    segment.error = undefined;
    this.setSegment(meeting, segment);
    try {
      const bytes = new Uint8Array(fsSync.readFileSync(segment.audioPath));
      const result = await this.options.transcribe(bytes, segment.mime, { timeoutMs });
      const text = (typeof result === 'string' ? result : result.text).trim();
      segment.status = text ? 'done' : 'empty';
      segment.text = text || undefined;
      segment.transcriptPath = text ? path.join(this.root, id, 'transcripts', `${segment.id}.json`) : undefined;
      if (segment.transcriptPath) {
        fsSync.mkdirSync(path.dirname(segment.transcriptPath), { recursive: true });
        fsSync.writeFileSync(segment.transcriptPath, JSON.stringify({ segment, text }, null, 2) + '\n');
      }
      segment.error = undefined;
      this.retryStart.delete(segmentId);
      this.setSegment(meeting, segment);
    } catch (error) {
      const kind = classifySegmentFailure(error);
      segment.failureKind = kind;
      segment.error = String((error as Error)?.message ?? error).slice(0, 500);
      const elapsed = Date.now() - this.retryStart.get(segmentId)!;
      if (TRANSIENT.has(kind) && elapsed < (this.options.retryBudgetMs ?? MEETING_RETRY_BUDGET_MS)) {
        const attempt = segment.attempt;
        this.setSegment(meeting, segment);
        this.scheduleRetry(id, segmentId, Math.min(5_000, (this.options.retryDelayMs ?? 500) * 2 ** Math.max(0, attempt - 1)));
        return;
      }
      segment.status = 'failed';
      this.retryStart.delete(segmentId);
      this.setSegment(meeting, segment);
    }
  }

  pause(id: string): Meeting {
    const meeting = this.require(id);
    if (meeting.status !== 'recording') throw new Error('只有录音中的会议可以暂停');
    meeting.status = 'paused';
    meeting.captureEpochs.push({ epoch: meeting.captureEpochs.length + 1, startedAt: nowIso(), reason: 'pause' });
    this.persist(meeting);
    this.options.power?.release?.();
    return snapshot(meeting);
  }

  resume(id: string): Meeting {
    const meeting = this.require(id);
    if (meeting.status !== 'paused') throw new Error('只有暂停中的会议可以继续');
    meeting.status = 'recording';
    meeting.captureEpochs.push({ epoch: meeting.captureEpochs.length + 1, startedAt: nowIso(), reason: 'resume' });
    this.persist(meeting);
    this.options.power?.acquire?.();
    return snapshot(meeting);
  }

  stop(id: string): Meeting {
    const meeting = this.require(id);
    if (meeting.status === 'processing' || meeting.status === 'ready') throw new Error('会议已经停止');
    meeting.status = 'processing';
    const lastEpoch = meeting.captureEpochs[meeting.captureEpochs.length - 1];
    if (lastEpoch && !lastEpoch.endedAt) lastEpoch.endedAt = nowIso();
    this.persist(meeting);
    this.options.power?.release?.();
    const snapshotValue = snapshot(meeting);
    // final pass：队列里的段会继续；failed 网络段也可在这个窗口做一次手动重试。
    for (const segment of meeting.segments) {
      if (segment.status === 'failed' && TRANSIENT.has(segment.failureKind)) this.enqueue(id, segment.id);
    }
    this.pump(id);
    return snapshotValue;
  }

  private finishProcessing(id: string): void {
    const meeting = this.require(id);
    if (meeting.status !== 'processing') return;
    for (const segment of meeting.segments) {
      if (segment.status === 'failed') segment.status = 'missing';
    }
    meeting.status = 'ready';
    this.persist(meeting);
  }

  retrySegment(id: string, segmentId: string): Meeting {
    const meeting = this.require(id);
    const segment = meeting.segments.find(s => s.id === segmentId || s.clientSegmentId === segmentId);
    if (!segment) throw new Error('分段不存在');
    if (!fsSync.existsSync(segment.audioPath)) throw new Error('原始音频已删除，不能重试');
    if (this.active.get(id)?.has(segment.id)) throw new Error('分段正在转写，不能重复重试');
    if ((this.queue.get(id) ?? []).includes(segment.id)) throw new Error('分段已排队，不能重复重试');
    if (!['failed', 'missing'].includes(segment.status)) throw new Error('只有失败/缺失分段可以重试');
    this.enqueue(id, segment.id);
    return snapshot(this.require(id));
  }

  delete(id: string): void {
    this.loadIndex();
    const meeting = this.require(id);
    this.options.power?.release?.();
    for (const timer of meeting.timers ?? []) clearTimeout(timer);
    meeting.timers?.clear();
    this.index.delete(id);
    fsSync.rmSync(path.join(this.root, id), { recursive: true, force: true });
  }

  /** 测试/收尾用：等待当前 meeting 排队与活动转写任务结算。 */
  async waitForIdle(id: string): Promise<void> {
    const meeting = this.require(id);
    while ((this.queue.get(id)?.length ?? 0) > 0 || (meeting.inflight?.size ?? 0) > 0) {
      await Promise.all([...(meeting.inflight ?? [])]);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  systemSuspend(): void {
    this.loadIndex();
    for (const meeting of this.index.values()) {
      if (meeting.status !== 'recording') continue;
      const last = meeting.captureEpochs[meeting.captureEpochs.length - 1];
      if (last && !last.endedAt) last.endedAt = nowIso();
      meeting.captureEpochs.push({ epoch: meeting.captureEpochs.length + 1, startedAt: nowIso(), reason: 'suspend' });
      this.persist(meeting);
    }
  }

  systemResume(): void {
    this.loadIndex();
    for (const meeting of this.index.values()) {
      if (meeting.status !== 'recording') continue;
      const last = meeting.captureEpochs[meeting.captureEpochs.length - 1];
      if (last && !last.endedAt) last.endedAt = nowIso();
      meeting.captureEpochs.push({ epoch: meeting.captureEpochs.length + 1, startedAt: nowIso(), reason: 'resume' });
      this.persist(meeting);
    }
  }

  dispose(): void {
    for (const meeting of this.index.values()) for (const timer of meeting.timers ?? []) clearTimeout(timer);
  }

  /** 异步启动纪要生成；调用方立即拿回当前状态，进度通过 onChange 广播。 */
  startMinutes(id: string, input: MeetingMinutesInput): Meeting {
    const meeting = this.require(id);
    if (meeting.minutes.status === 'running') throw new Error('纪要正在生成');
    if (!['processing', 'ready', 'failed'].includes(meeting.status)) throw new Error('请先停止会议再生成纪要');
    if ((this.queue.get(id)?.length ?? 0) > 0 || (this.active.get(id)?.size ?? 0) > 0
      || meeting.segments.some(s => ['queued', 'transcribing'].includes(s.status))) {
      throw new Error('还有分段正在转写，请等待全部结算后再生成纪要');
    }
    if (typeof input.provider !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/i.test(input.provider)) throw new Error('提供商无效');
    if (typeof input.model !== 'string' || !/^[A-Za-z0-9._:/-]{1,200}$/.test(input.model)) throw new Error('模型无效');
    if (!this.options.minutesCall) throw new Error('纪要模型不可用');
    const doneSegments = meeting.segments.filter(s => s.status === 'done');
    if (!doneSegments.length) throw new Error('没有可生成纪要的转写内容');
    const chunks = chunkTranscript(doneSegments);
    const missing = meeting.segments.filter(s => s.status !== 'done' && s.status !== 'empty').map(s => s.id);
    meeting.minutes = {
      status: 'running', provider: input.provider, model: input.model,
      mappedChunks: chunks.length, completedChunks: 0,
    };
    meeting.status = meeting.status === 'ready' ? 'ready' : 'processing';
    this.persist(meeting);
    void (async () => {
      const maps: Array<{ chunkIndex: number; markdown: string; segmentIds: string[] }> = [];
      try {
        for (const chunk of chunks) {
          const markdown = await this.options.minutesCall!({
            phase: 'map', prompt: buildMapPrompt(chunk), provider: input.provider, model: input.model, timeoutMs: 240_000,
          });
          const text = String(markdown || '').trim();
          if (!text) throw new Error(`纪要第 ${chunk.index + 1} 块没有输出`);
          maps.push({ chunkIndex: chunk.index, markdown: text, segmentIds: chunk.segmentIds });
          const current = this.require(id);
          current.minutes = { ...current.minutes, completedChunks: maps.length };
          const mapPath = path.join(this.root, id, 'minutes', `map-${String(chunk.index + 1).padStart(4, '0')}.md`);
          fsSync.mkdirSync(path.dirname(mapPath), { recursive: true });
          fsSync.writeFileSync(mapPath, text + '\n');
          this.persist(current);
        }
        const reducePrompt = buildReducePrompt({
          title: meeting.title, maps, missingSegmentIds: missing,
          missingMs: this.require(id).coverage.missingMs,
        });
        const minutes = String(await this.options.minutesCall!({
          phase: 'reduce', prompt: reducePrompt, provider: input.provider, model: input.model, timeoutMs: 300_000,
        })).trim();
        if (!minutes) throw new Error('纪要 reduce 没有输出');
        const dir = path.join(this.root, id, 'minutes');
        fsSync.mkdirSync(dir, { recursive: true });
        fsSync.writeFileSync(path.join(dir, 'minutes.jsonl'), maps.map(m => JSON.stringify(m)).join('\n') + '\n');
        fsSync.writeFileSync(path.join(dir, 'minutes.md'), minutes + '\n');
        const current = this.require(id);
        current.minutes = {
          status: 'done', provider: input.provider, model: input.model, mappedChunks: chunks.length,
          completedChunks: maps.length, path: path.join(dir, 'minutes.md'), generatedAt: nowIso(),
        };
        current.status = 'ready';
        this.persist(current);
      } catch (error) {
        const current = this.require(id);
        current.minutes = {
          ...current.minutes, status: 'failed',
          error: String((error as Error)?.message ?? error).slice(0, 500), generatedAt: nowIso(),
        };
        if (current.status === 'processing') current.status = 'ready';
        this.persist(current);
      }
    })();
    return snapshot(this.require(id));
  }
}

// MeetingStatus 目前主要出现在 manifest；导出别名方便测试与 IPC 层引用。
export type { MeetingStatus, SegmentStatus };
