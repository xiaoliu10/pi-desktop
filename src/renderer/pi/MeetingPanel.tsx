import { useCallback, useEffect, useRef, useState } from 'react';
import type { LocalPiApi } from '../../shared/pi';
import type { Meeting, MeetingSegmentInput, MeetingSummary } from '../../shared/meeting';
import type { VoiceConfig } from '../../shared/voice';
import {
  MEETING_MAX_TOTAL_MS, MEETING_MINUTES_DEFAULT_MODEL, MEETING_MINUTES_DEFAULT_PROVIDER,
  MEETING_SEGMENT_MS,
} from '../../shared/meeting';
import { encodeWav16kMono } from '../../shared/voice-wav';
import './meeting.css';

type Phase = 'idle' | 'requesting' | 'recording' | 'paused' | 'stopping';

interface ActiveSegment {
  recorder: MediaRecorder;
  chunks: Blob[];
  clientSegmentId: string;
  startOffsetMs: number;
  wallStartedAt: string;
  done: Promise<void>;
  resolve: () => void;
  stopping: boolean;
}

/** 每段的 WAV 转码 + IPC append 都要等完成；stop 不能越过旧段。 */
type SegmentPersistence = Promise<void>;

async function toWav16k(blob: Blob): Promise<Uint8Array | undefined> {
  const Ctx = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
  if (!Ctx) return undefined;
  const ctx = new Ctx();
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    const channels = Array.from({ length: decoded.numberOfChannels }, (_, i) => decoded.getChannelData(i));
    return encodeWav16kMono(channels, decoded.sampleRate);
  } catch {
    return undefined;
  } finally {
    void ctx.close().catch(() => undefined);
  }
}

function formatTime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h, m, s].map(n => String(n).padStart(2, '0')).join(':');
}

function failureLabel(kind: string): string {
  return ({
    network: '网络失败，可重试', rate_limited: '限流，可重试', provider: '转写服务失败',
    auth: '认证失败，请检查语音模型', bad_request: '音频格式或参数错误', too_large: '音频段过大',
    timeout: '转写超时', capture_gap: '录制缺口', none: '',
  } as Record<string, string>)[kind] || kind;
}

export function MeetingPanel() {
  const api = (window as unknown as { localPi: LocalPiApi }).localPi;
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [history, setHistory] = useState<MeetingSummary[]>([]);
  const [voice, setVoice] = useState<VoiceConfig | null>(null);
  const [title, setTitle] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  const [minutesText, setMinutesText] = useState('');
  const [provider, setProvider] = useState(MEETING_MINUTES_DEFAULT_PROVIDER);
  const [model, setModel] = useState(MEETING_MINUTES_DEFAULT_MODEL);
  const meetingRef = useRef<Meeting | null>(null);
  const phaseRef = useRef<Phase>('idle');
  const streamRef = useRef<MediaStream | null>(null);
  const activeRef = useRef<ActiveSegment | null>(null);
  const captureEpochRef = useRef(1);
  const segmentCounterRef = useRef(0);
  const startedAtRef = useRef(0);
  const desiredRecordingRef = useRef(false);
  const startingRef = useRef(false);
  const pendingPersistenceRef = useRef(new Set<SegmentPersistence>());
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const updateMeeting = useCallback((next: Meeting) => {
    meetingRef.current = next;
    setMeeting(next);
  }, []);

  const refreshHistory = useCallback(async () => {
    if (typeof api.meetingList !== 'function') return;
    try { setHistory(await api.meetingList()); } catch { /* 历史列表不阻塞新录音 */ }
  }, [api]);

  useEffect(() => {
    void api.voiceConfig().then(setVoice).catch(() => setVoice(null));
    void refreshHistory();
    if (typeof api.onMeetingChanged !== 'function') return;
    return api.onMeetingChanged(next => {
      if (meetingRef.current?.id === next.id) updateMeeting(next);
      void refreshHistory();
    });
  }, [api, refreshHistory, updateMeeting]);

  useEffect(() => {
    if (meeting?.minutes.status !== 'done' || typeof api.meetingMinutesText !== 'function') return;
    void api.meetingMinutesText(meeting.id).then(text => setMinutesText(text || '')).catch(() => undefined);
  }, [api, meeting?.id, meeting?.minutes.status, meeting?.minutes.generatedAt]);

  const releaseStream = useCallback(() => {
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
  }, []);

  const stopTicker = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
  }, []);

  const startSegment = useCallback(() => {
    const stream = streamRef.current;
    const current = meetingRef.current;
    if (!stream || !current || !desiredRecordingRef.current) return;
    const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
      .find(type => MediaRecorder.isTypeSupported(type)) || '';
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    let resolve!: () => void;
    const done = new Promise<void>(r => { resolve = r; });
    const segment: ActiveSegment = {
      recorder,
      chunks: [],
      clientSegmentId: `${current.id}-client-${++segmentCounterRef.current}-${Date.now().toString(36)}`,
      startOffsetMs: Math.max(0, performance.now() - startedAtRef.current),
      wallStartedAt: new Date().toISOString(),
      done,
      resolve,
      stopping: false,
    };
    activeRef.current = segment;
    recorder.ondataavailable = event => { if (event.data.size > 0) segment.chunks.push(event.data); };
    recorder.onerror = () => {
      setError('录音设备发生错误，已停止采集；已落盘分段会保留');
      if (phaseRef.current === 'recording') void stop();
    };
    recorder.onstop = () => {
      if (segment.stopping) return;
      segment.stopping = true;
      void (async () => {
        const endOffsetMs = Math.max(segment.startOffsetMs + 1, performance.now() - startedAtRef.current);
        // 下一段立即启动，不等转写/上传，避免分段间隙。
        activeRef.current = null;
        if (desiredRecordingRef.current && meetingRef.current?.id === current.id) startSegment();
        const persistence = (async () => {
          try {
            const blob = new Blob(segment.chunks, { type: recorder.mimeType || 'audio/webm' });
            const wav = await toWav16k(blob);
            const bytes = wav ?? new Uint8Array(await blob.arrayBuffer());
            const meta: Omit<MeetingSegmentInput, 'clientSegmentId'> = {
              captureEpoch: captureEpochRef.current,
              startOffsetMs: Math.floor(segment.startOffsetMs),
              endOffsetMs: Math.floor(endOffsetMs),
              wallStartedAt: segment.wallStartedAt,
              wallEndedAt: new Date().toISOString(),
              mime: wav ? 'audio/wav' : (recorder.mimeType || 'audio/webm'),
            };
            const ack = await api.meetingAppendSegment(current.id, segment.clientSegmentId, bytes, meta);
            updateMeeting(ack.meeting);
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          } finally {
            segment.resolve();
          }
        })();
        pendingPersistenceRef.current.add(persistence);
        void persistence.finally(() => pendingPersistenceRef.current.delete(persistence));
      })();
    };
    // 不使用 timeslice 碎片：每段由一次完整 start/stop 生成独立可播放容器。
    recorder.start();
    const segmentMs = Number((globalThis as { __PI_MEETING_SEGMENT_MS?: number }).__PI_MEETING_SEGMENT_MS) || MEETING_SEGMENT_MS;
    window.setTimeout(() => {
      if (activeRef.current === segment && recorder.state === 'recording') recorder.stop();
    }, segmentMs);
  }, [api, updateMeeting]);

  const startTicker = useCallback(() => {
    stopTicker();
    timerRef.current = setInterval(() => {
      const value = performance.now() - startedAtRef.current;
      setElapsed(value);
      if (value >= MEETING_MAX_TOTAL_MS) {
        setError('已达到 8 小时单次上限，请停止并生成纪要');
        desiredRecordingRef.current = false;
        const active = activeRef.current;
        if (active?.recorder.state === 'recording') active.recorder.stop();
      }
    }, 250);
  }, [stopTicker]);

  const start = async () => {
    if (startingRef.current || desiredRecordingRef.current) return;
    if (!voice?.activeId || !voice.models.some(m => m.id === voice.activeId && m.ready)) {
      setError('请先在「设置 → 语音模型」配置并启用一个转写模型');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('当前环境不支持麦克风采集');
      return;
    }
    startingRef.current = true;
    setError('');
    setMinutesText('');
    setPhase('requesting');
    phaseRef.current = 'requesting';
    let stream: MediaStream | undefined;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
      const created = await api.meetingCreate({ title: title.trim() || undefined });
      streamRef.current = stream;
      updateMeeting(created);
      captureEpochRef.current = 1;
      segmentCounterRef.current = 0;
      startedAtRef.current = performance.now();
      setElapsed(0);
      desiredRecordingRef.current = true;
      setPhase('recording');
      phaseRef.current = 'recording';
      startSegment();
      startTicker();
    } catch (e) {
      for (const track of stream?.getTracks() ?? []) track.stop();
      setError(e instanceof Error ? e.message : String(e));
      setPhase('idle');
      phaseRef.current = 'idle';
    } finally {
      startingRef.current = false;
    }
  };

  const stopActive = async () => {
    desiredRecordingRef.current = false;
    const active = activeRef.current;
    if (active && active.recorder.state === 'recording') active.recorder.stop();
    // 旧段的转码/append 可能还没结束；必须全部落盘后再 meetingStop，否则会被主进程拒绝。
    await Promise.allSettled([...pendingPersistenceRef.current]);
    await active?.done;
  };

  const stop = async () => {
    const current = meetingRef.current;
    if (!current || phaseRef.current === 'stopping') return;
    setPhase('stopping');
    phaseRef.current = 'stopping';
    setError('');
    try {
      await stopActive();
      releaseStream();
      stopTicker();
      const stopped = await api.meetingStop(current.id);
      updateMeeting(stopped);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPhase('idle');
      phaseRef.current = 'idle';
    }
  };

  const pause = async () => {
    const current = meetingRef.current;
    if (!current || phase !== 'recording') return;
    try {
      await stopActive();
      releaseStream();
      stopTicker();
      updateMeeting(await api.meetingPause(current.id));
      setPhase('paused');
      phaseRef.current = 'paused';
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const resume = async () => {
    const current = meetingRef.current;
    if (!current || phase !== 'paused') return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
      streamRef.current = stream;
      updateMeeting(await api.meetingResume(current.id));
      captureEpochRef.current += 1;
      desiredRecordingRef.current = true;
      setPhase('recording');
      phaseRef.current = 'recording';
      startSegment();
      startTicker();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const retrySegment = async (segmentId: string) => {
    if (!meeting) return;
    try { updateMeeting(await api.meetingRetrySegment(meeting.id, segmentId)); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const generateMinutes = async () => {
    if (!meeting) return;
    try {
      setError('');
      updateMeeting(await api.meetingGenerateMinutes(meeting.id, { provider, model }));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const deleteMeeting = async (id: string) => {
    if (typeof api.meetingDelete !== 'function') return;
    if (meetingRef.current?.id === id && (desiredRecordingRef.current || phaseRef.current !== 'idle')) {
      setError('录音中的会议不能删除，请先停止');
      return;
    }
    try {
      await api.meetingDelete(id);
      if (meetingRef.current?.id === id) { meetingRef.current = null; setMeeting(null); setMinutesText(''); }
      await refreshHistory();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const openMeeting = async (id: string) => {
    if (desiredRecordingRef.current || phaseRef.current !== 'idle') {
      setError('录音中不能切换会议；请先停止，避免麦克风和分段丢失');
      return;
    }
    try {
      const found = await api.meetingGet(id);
      updateMeeting(found);
      setPhase('idle');
      setMinutesText('');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const activeModel = voice?.models.find(m => m.id === voice.activeId);
  const canRecord = phase === 'idle' && (!meeting || ['ready', 'failed'].includes(meeting.status));
  const hasTranscript = Boolean(meeting?.segments.some(s => s.status === 'done'));
  const busy = phase === 'requesting' || phase === 'stopping';

  return (
    <div className="meeting-panel" data-meeting-panel="true">
      <div className="meeting-hero">
        <div>
          <div className="meeting-eyebrow">MEETING NOTES</div>
          <h2>{meeting?.title || '会议录音'}</h2>
          <p>只采集本机麦克风；分段转写保留覆盖范围，不会把缺段伪装成完整纪要。</p>
        </div>
        {(phase === 'recording' || phase === 'paused') && (
          <div className={`meeting-live ${phase === 'paused' ? 'is-paused' : ''}`}>
            <span className="meeting-live-dot" />
            {phase === 'paused' ? '已暂停' : '录音中'} {formatTime(elapsed)}
          </div>
        )}
      </div>

      {!meeting || canRecord ? (
        <div className="meeting-start-card">
          <label htmlFor="meeting-title">会议名称</label>
          <input id="meeting-title" value={title} onChange={e => setTitle(e.target.value)} placeholder="例如：项目周会" disabled={busy} />
          <div className="meeting-asr-line">
            <span>转写模型</span>
            <strong>{activeModel?.name || '未配置'}</strong>
          </div>
          <div className="meeting-privacy">录音分段会上传到你配置的语音模型提供商；纪要会调用你选择的模型提供商。原始音频、转写和纪要保存在本机应用数据目录；单次最长 8 小时。开始即表示你已获得参会者同意。</div>
          <button className="meeting-primary" onClick={() => void start()} disabled={busy}>
            {phase === 'requesting' ? '正在请求麦克风…' : '开始录音'}
          </button>
        </div>
      ) : (
        <div className="meeting-session-card">
          <div className="meeting-session-head">
            <div>
              <strong>{meeting.status === 'recording' ? '正在采集' : meeting.status === 'processing' ? '正在整理' : meeting.status === 'paused' ? '已暂停' : '会议已结束'}</strong>
              <span>{meeting.segments.length} 个分段 · 已转写 {Math.round(meeting.coverage.transcribedMs / 1000)} 秒</span>
            </div>
            {meeting.coverage.missingMs > 0 && <span className="meeting-warning">缺失 {Math.round(meeting.coverage.missingMs / 1000)} 秒</span>}
          </div>
          <div className="meeting-controls">
            {phase === 'recording' && <button onClick={() => void pause()}>暂停</button>}
            {phase === 'paused' && <button onClick={() => void resume()}>继续录音</button>}
            {(phase === 'recording' || phase === 'paused') && <button className="meeting-danger" onClick={() => void stop()}>停止并生成纪要</button>}
            {phase === 'stopping' && <span>正在保存全部分段…</span>}
          </div>
        </div>
      )}

      {error && <div className="meeting-error" role="alert">{error}</div>}

      {meeting && meeting.segments.length > 0 && (
        <section className="meeting-section">
          <div className="meeting-section-title"><h3>分段转写</h3><span>{meeting.coverage.emptyMs > 0 ? `静音/空段 ${Math.round(meeting.coverage.emptyMs / 1000)} 秒` : ''}</span></div>
          <div className="meeting-segments">
            {meeting.segments.map(segment => (
              <div className="meeting-segment" key={segment.id}>
                <div className="meeting-segment-meta">
                  <span>{formatTime(segment.startOffsetMs)}–{formatTime(segment.endOffsetMs)}</span>
                  <span className={`meeting-segment-status is-${segment.status}`}>
                    {segment.status === 'done' ? '完成' : segment.status === 'empty' ? '空段' : segment.status === 'transcribing' || segment.status === 'queued' ? '转写中' : '失败'}
                  </span>
                </div>
                {segment.text ? <p>{segment.text}</p> : <p className="meeting-muted">{segment.error || (segment.status === 'empty' ? '没有识别到语音' : '等待转写')}</p>}
                {['failed', 'missing'].includes(segment.status) && (
                  <button className="meeting-retry" onClick={() => void retrySegment(segment.id)}>重试此段 · {failureLabel(segment.failureKind)}</button>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {meeting && ['processing', 'ready', 'failed'].includes(meeting.status) && (
        <section className="meeting-section meeting-minutes">
          <div className="meeting-section-title"><h3>会议纪要</h3>{meeting.minutes.status === 'running' && <span>已整理 {meeting.minutes.completedChunks || 0}/{meeting.minutes.mappedChunks || 0} 块</span>}</div>
          <div className="meeting-model-row">
            <input aria-label="纪要提供商" value={provider} onChange={e => setProvider(e.target.value)} />
            <input aria-label="纪要模型" value={model} onChange={e => setModel(e.target.value)} />
            <button className="meeting-primary" disabled={!hasTranscript || meeting.minutes.status === 'running'} onClick={() => void generateMinutes()}>
              {meeting.minutes.status === 'running' ? '正在生成…' : meeting.minutes.status === 'done' ? '重新生成' : '生成纪要'}
            </button>
          </div>
          {meeting.minutes.error && <div className="meeting-error">{meeting.minutes.error}</div>}
          {minutesText && <pre className="meeting-minutes-text">{minutesText}</pre>}
          {meeting.minutes.status === 'done' && <button onClick={() => void api.meetingExport(meeting.id)}>导出 Markdown</button>}
        </section>
      )}

      {history.length > 0 && (
        <section className="meeting-section meeting-history">
          <div className="meeting-section-title"><h3>最近会议</h3></div>
          {history.slice(0, 6).map(item => (
            <div key={item.id} className={`meeting-history-row ${meeting?.id === item.id ? 'is-active' : ''}`}>
              <button onClick={() => void openMeeting(item.id)}>
                <span>{item.title}</span><small>{new Date(item.createdAt).toLocaleString()}</small>
              </button>
              <button aria-label={`删除 ${item.title}`} title="删除音频、转写与纪要" onClick={() => void deleteMeeting(item.id)}>删除</button>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
