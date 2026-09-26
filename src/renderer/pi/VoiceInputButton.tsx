import { useEffect, useRef, useState } from 'react';
import { Icon } from '../replica/Icons';
import type { ComposerLabels } from '../replica/contracts';
import { VOICE_MAX_RECORD_MS } from '../../shared/voice';

type Phase = 'idle' | 'checking' | 'requesting' | 'recording' | 'transcribing';

export function VoiceInputButton(props: {
  labels: ComposerLabels;
  disabled?: boolean;
  zh: boolean;
  onTranscript: (text: string) => void;
  onError: (message: string) => void;
  onNotConfigured: () => void;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const phaseRef = useRef<Phase>('idle');
  const epoch = useRef(0);
  const mounted = useRef(false);
  const releaseRef = useRef<() => void>(() => {});
  const stopRef = useRef<() => void>(() => {});
  const latest = useRef(props);
  latest.current = props;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      epoch.current++;
      releaseRef.current();
    };
  }, []);

  const transition = (next: Phase) => { phaseRef.current = next; setPhase(next); };
  const start = async () => {
    if (phaseRef.current !== 'idle') return;
    const id = ++epoch.current;
    const live = () => mounted.current && epoch.current === id;
    const message = (zh: string, en: string) => latest.current.zh ? zh : en;
    let stream: MediaStream | undefined;
    let rec: MediaRecorder | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let chunks: Blob[] = [];
    const release = () => {
      clearTimeout(timer);
      if (rec) {
        rec.onstop = rec.ondataavailable = rec.onerror = null;
        if (rec.state !== 'inactive') { try { rec.stop(); } catch { /* already stopped */ } }
      }
      stream?.getTracks().forEach(t => t.stop());
      stream = undefined;
      chunks = [];
    };
    releaseRef.current = release;
    const fail = (err: unknown) => {
      release();
      if (!live()) return;
      epoch.current++;
      transition('idle');
      const error = err as Error;
      latest.current.onError(/NotAllowed|PermissionDenied|denied/i.test(`${error?.name} ${error?.message}`)
        ? message('麦克风权限被拒绝，请在系统设置中允许后重试', 'Microphone access denied; allow it in system settings and retry')
        : String(error?.message || err));
    };
    transition('checking');
    try {
      const config = await window.localPi.voiceConfig();
      if (!live()) return;
      const active = config.models.find(m => m.id === config.activeId) ?? config.models[0];
      if (!active?.ready) { transition('idle'); latest.current.onNotConfigured(); return; }
      transition('requesting');
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        throw new Error(message('当前环境不支持麦克风录音', 'Microphone recording is unavailable in this environment'));
      }
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!live()) { release(); return; }
      const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(t => MediaRecorder.isTypeSupported(t));
      rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const recorder = rec;
      rec.ondataavailable = e => { if (live() && e.data.size) chunks.push(e.data); };
      rec.onerror = () => fail(new Error(message('录音失败，请重试', 'Recording failed, please retry')));
      rec.onstop = () => {
        if (!live()) return;
        transition('transcribing');
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        release();
        void (async () => {
          try {
            if (!blob.size) throw new Error(message('录音数据为空，请重试', 'Recording is empty; please retry'));
            const bytes = new Uint8Array(await blob.arrayBuffer());
            if (!live()) return;
            const text = (await window.localPi.voiceTranscribe(bytes, blob.type)).trim();
            if (!live()) return;
            if (!text) throw new Error(message('未识别到语音内容，请重试', 'No speech recognized; please retry'));
            latest.current.onTranscript(text);
            transition('idle');
            epoch.current++;
          } catch (err) { fail(err); }
        })();
      };
      stopRef.current = () => {
        if (!live() || phaseRef.current !== 'recording') return;
        transition('transcribing');
        clearTimeout(timer);
        try { recorder.stop(); } catch (err) { fail(err); }
        // stop queues the final data/stop events; the microphone need not remain open.
        stream?.getTracks().forEach(t => t.stop());
        stream = undefined;
      };
      rec.start(250);
      transition('recording');
      timer = setTimeout(() => stopRef.current(), VOICE_MAX_RECORD_MS);
    } catch (err) { fail(err); }
  };
  const busy = phase !== 'idle' && phase !== 'recording';
  const label = phase === 'checking' ? (props.zh ? '正在检查语音配置…' : 'Checking voice configuration…')
    : phase === 'requesting' ? (props.zh ? '正在等待麦克风权限…' : 'Waiting for microphone permission…')
    : phase === 'recording' ? (props.labels.voiceStop ?? 'Stop recording')
    : phase === 'transcribing' ? (props.labels.voiceTranscribing ?? 'Transcribing…')
    : (props.labels.voiceStart ?? 'Start voice input');
  return <>
    <button type="button"
      className={`pi-iconbtn pi-composer__voice ${phase === 'recording' ? 'pi-composer__voice--rec' : ''} ${busy ? 'pi-composer__voice--busy' : ''}`}
      onClick={() => { if (!props.disabled) { if (phaseRef.current === 'recording') stopRef.current(); else void start(); } }}
      disabled={props.disabled || busy} aria-label={label} aria-pressed={phase === 'recording'} title={label}>
      <Icon name={busy ? 'loader' : 'mic'} size={16} />
    </button>
    {phase !== 'idle' && <span role="status" style={{ fontSize: 12 }}>{phase === 'recording' ? (props.zh ? '正在录音，点击停止' : 'Recording; click to stop') : label}</span>}
  </>;
}
