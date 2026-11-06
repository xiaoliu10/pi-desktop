/**
 * 会议录音模式契约。
 *
 * 录音在 renderer 分段采集；main 只做会议 manifest、音频段持久化、ASR 队列、
 * transcript/minutes 存储。API key 永不出 main；renderer 不接触 meeting 文件路径
 * 以外的本地文件系统。
 */

export type MeetingStatus = 'recording' | 'paused' | 'processing' | 'ready' | 'failed';

export type SegmentStatus =
  | 'captured' | 'queued' | 'transcribing'
  | 'done' | 'empty' | 'failed' | 'missing';

export type SegmentFailureKind =
  | 'none' | 'network' | 'rate_limited' | 'provider'
  | 'auth' | 'bad_request' | 'too_large' | 'timeout' | 'capture_gap';

export interface MeetingSegmentInput {
  /** 客户端生成；重试/重复 ACK 用它幂等。 */
  clientSegmentId: string;
  captureEpoch: number;
  startOffsetMs: number;
  endOffsetMs: number;
  wallStartedAt: string;
  wallEndedAt: string;
  mime: string;
}

export interface MeetingSegment extends MeetingSegmentInput {
  id: string;
  index: number;
  audioPath: string;
  bytes: number;
  sha256: string;
  status: SegmentStatus;
  failureKind: SegmentFailureKind;
  attempt: number;
  text?: string;
  transcriptPath?: string;
  error?: string;
}

export interface MeetingCoverage {
  capturedMs: number;
  transcribedMs: number;
  emptyMs: number;
  missingMs: number;
}

export interface MeetingMinutesState {
  status: 'idle' | 'running' | 'done' | 'failed';
  provider?: string;
  model?: string;
  mappedChunks?: number;
  completedChunks?: number;
  path?: string;
  error?: string;
  generatedAt?: string;
}

export interface MeetingCaptureEpoch {
  epoch: number;
  startedAt: string;
  endedAt?: string;
  reason: 'start' | 'pause' | 'resume' | 'device_change' | 'error' | 'app_resume' | 'suspend';
}

export interface Meeting {
  version: 1;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  status: MeetingStatus;
  captureEpochs: MeetingCaptureEpoch[];
  segments: MeetingSegment[];
  coverage: MeetingCoverage;
  minutes: MeetingMinutesState;
}

export interface MeetingSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  status: MeetingStatus;
  segmentCount: number;
  transcribedCount: number;
  failedCount: number;
  capturedMs: number;
  missingMs: number;
  hasMinutes: boolean;
}

export interface MeetingSegmentAck {
  meeting: Meeting;
  segment: MeetingSegment;
  duplicated: boolean;
}

export interface MeetingMinutesInput {
  provider: string;
  model: string;
}

export interface MeetingExportResult {
  transcriptPath: string;
  minutesPath?: string;
}

export const MEETING_MAX_SEGMENT_MS = 5 * 60_000 + 20_000;
/** 默认目标段长；到点后可有短暂静音等待，但硬上限是 MEETING_MAX_SEGMENT_MS。 */
export const MEETING_SEGMENT_MS = 5 * 60_000;
export const MEETING_MAX_TOTAL_MS = 8 * 60 * 60_000;
export const MEETING_MAX_BYTES = 24 * 1024 * 1024;
export const MEETING_CONCURRENCY = 2;
/** ASR transient 错误的时间预算；非 transient 直接终态。 */
export const MEETING_RETRY_BUDGET_MS = 120_000;
export const MEETING_MINUTES_DEFAULT_PROVIDER = 'openai';
export const MEETING_MINUTES_DEFAULT_MODEL = 'gpt-5.2';
