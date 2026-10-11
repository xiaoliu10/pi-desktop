import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PiHistory } from '../../shared/pi';
import { Icon } from '../replica/Icons';
import { TurnArticle } from '../replica/chat/ChatView';
import { executionTurns } from '../replica/chat/execution';
import { replicaLabels } from '../replica/i18n';
import { conversationMessages, usePiStore } from './adapter';

export function sidecarLabelsFor(lang: 'en' | 'zh') {
  return lang === 'zh'
    ? { title: '副驾', start: '点击开始副驾对话', hint: '独立对话 · 仅 read 工具 · 不共享主会话上下文', placeholder: '向副驾提问…', send: '发送', stop: '停止', close: '关闭副驾面板', retry: '重新连接', deny: '取消 / 拒绝', allow: '允许本次', submit: '确定' }
    : { title: 'Sidecar', start: 'Start a sidecar conversation', hint: 'Independent conversation · read tool only · no main context', placeholder: 'Ask the sidecar…', send: 'Send', stop: 'Stop', close: 'Close sidecar panel', retry: 'Reconnect', deny: 'Cancel / deny', allow: 'Allow once', submit: 'Submit' };
}

/** Never selects a session: history is local; live data stays in the keyed store. */
export function SidecarPanel({ mainKey, autoStart, onClose }: { mainKey: string; autoStart: boolean; onClose: () => void }) {
  const s = usePiStore();
  const t = sidecarLabelsFor(s.lang);
  const [key, setKey] = useState<string>();
  const [history, setHistory] = useState<PiHistory>();
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const [draft, setDraft] = useState(() => { try { return localStorage.getItem(`pi.sidecarDraft:${mainKey}`) ?? ''; } catch { return ''; } });
  const [answer, setAnswer] = useState('');
  const alive = useRef(true), ensuring = useRef(false);
  const scroll = useRef<HTMLDivElement>(null), follow = useRef(true);
  const run = s.runs.find(r => r.key === key);
  const busy = !!run && ['starting', 'running', 'stopping'].includes(run.status);
  const dialog = s.dialogs.find(d => d.key === key);
  useEffect(() => { setAnswer(String(dialog?.request.prefill ?? '')); }, [dialog?.generation, dialog?.request.id]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { try { localStorage.setItem(`pi.sidecarDraft:${mainKey}`, draft); } catch { /* Draft storage is best effort. */ } }, [mainKey, draft]);

  const ensure = useCallback(async () => {
    if (ensuring.current) return;
    ensuring.current = true; setLoading(true); setError(undefined);
    try {
      const result = await window.localPi!.sidecarEnsure(mainKey);
      if (!alive.current) return;
      setKey(result.key);
      // The event pipeline may already hold a newer snapshot than this IPC reply.
      usePiStore.setState(state => state.runs.some(r => r.key === result.key) ? {} : { runs: [...state.runs, result.run] });
    } catch (e) { if (alive.current) setError(String((e as Error).message ?? e)); }
    finally { ensuring.current = false; if (alive.current) setLoading(false); }
  }, [mainKey]);

  useEffect(() => {
    let cancelled = false;
    void window.localPi!.sidecarBinding(mainKey).then(bound => {
      if (cancelled) return;
      setKey(bound);
      if (bound || autoStart) void ensure(); else setLoading(false);
    }).catch(e => { if (!cancelled) { setError(String(e)); setLoading(false); } });
    return () => { cancelled = true; };
  }, [mainKey, autoStart, ensure]);

  useEffect(() => {
    if (!key) return;
    let cancelled = false, inFlight = false, again = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      if (inFlight) { again = true; return; }
      inFlight = true;
      try {
        const value = await window.localPi!.history(key);
        if (!cancelled) setHistory(value);
      } catch (e) { if (!cancelled) setError(String((e as Error).message ?? e)); }
      finally { inFlight = false; if (again && !cancelled) { again = false; void load(); } }
    };
    void load();
    const unsubscribe = window.localPi!.onEvent(event => {
      const eventKey = event.type === 'run' ? event.run.key : 'key' in event ? event.key : undefined;
      if (event.type !== 'sessions-changed' && eventKey !== key) return;
      if (event.type === 'rpc' && !['agent_start', 'message_start', 'message_end', 'agent_settled'].includes(String(event.event.type))) return;
      if (!timer) timer = setTimeout(() => { timer = undefined; void load(); }, 180);
    });
    return () => { cancelled = true; clearTimeout(timer); unsubscribe(); };
  }, [key]);

  const live = key ? s.live[key] : undefined, tools = key ? s.toolProgress[key] : undefined;
  const turns = useMemo(() => executionTurns(conversationMessages(history?.branch ?? [], live, tools)), [history, live, tools]);
  useEffect(() => { if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [turns, busy, sending]);
  const send = async () => {
    if (!key || !draft.trim() || busy || sending || loading || dialog) return;
    const text = draft;
    setSending(true); setError(undefined);
    try {
      const result = await window.localPi!.sidecarEnsure(mainKey); // Reattach after an idle slot eviction.
      if (!alive.current) return;
      setKey(result.key);
      await window.localPi!.prompt(result.key, text, 'followUp');
      if (alive.current) setDraft(current => current === text ? '' : current);
    } catch (e) { if (alive.current) setError(String((e as Error).message ?? e)); }
    finally { if (alive.current) setSending(false); }
  };
  const stop = async () => {
    if (!key) return;
    try {
      const queue = await window.localPi!.stop(key);
      if (alive.current) { const restored = [...queue.steering, ...queue.followUp].join('\n'); if (restored) setDraft(d => [d, restored].filter(Boolean).join('\n')); }
    } catch (e) { if (alive.current) setError(String((e as Error).message ?? e)); }
  };
  const respond = async (response: { value?: string; confirmed?: boolean; cancelled?: boolean }) => {
    if (!dialog) return;
    try { await window.localPi!.respond(dialog.key, dialog.generation, { id: dialog.request.id, ...response }); }
    catch (e) { if (alive.current) setError(String((e as Error).message ?? e)); }
  };

  return <aside className="pi-sidecar" aria-label={t.title} data-sidecar-key={key}>
    <header><strong><Icon name="chat" size={16} />{t.title}</strong><button className="pi-iconbtn" aria-label={t.close} onClick={onClose}><Icon name="x" size={16} /></button></header>
    <small className="pi-sidecar__hint">{t.hint}</small>
    <div className="pi-sidecar__messages" ref={scroll} onScroll={e => { const el = e.currentTarget; follow.current = el.scrollHeight - el.clientHeight - el.scrollTop < 48; }}>
      {turns.map((turn, i) => <TurnArticle key={turn.id} m={turn} liveTurn={busy && i === turns.length - 1} labels={replicaLabels(s.lang).chat} />)}
      {error || run?.error ? <p role="alert" className="pi-sidecar__error">{error || run?.error}</p> : null}
      {(loading || busy || sending) && <p role="status" aria-label={replicaLabels(s.lang).chat.working}>…</p>}
      {!key && !loading && <button className="pi-btn pi-btn--outline" onClick={() => void ensure()}>{t.start}</button>}
      {key && !loading && (!run || run.status === 'error') && <button className="pi-btn pi-btn--outline" onClick={() => void ensure()}>{t.retry}</button>}
    </div>
    <footer>
      {dialog ? <section className="pi-sidecar__dialog" role="group" aria-label={String(dialog.request.title ?? t.title)}>
        <strong>{dialog.request.title}</strong>{dialog.request.message && <pre>{String(dialog.request.message)}</pre>}
        {dialog.request.method === 'select' ? dialog.request.options?.map(option => <button className="pi-btn pi-btn--outline" key={option} onClick={() => void respond({ value: option })}>{option}</button>) : dialog.request.method !== 'confirm' && <textarea aria-label={t.submit} value={answer} onChange={e => setAnswer(e.target.value)} />}
        <button className="pi-btn pi-btn--outline" onClick={() => void respond({ cancelled: true })}>{t.deny}</button>
        {dialog.request.method !== 'select' && <button className="pi-btn pi-btn--outline" onClick={() => void respond(dialog.request.method === 'confirm' ? { confirmed: true } : { value: answer })}>{dialog.request.method === 'confirm' ? t.allow : t.submit}</button>}
      </section> : <textarea aria-label={t.placeholder} placeholder={t.placeholder} value={draft} disabled={!key || loading} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} />}
      {busy || sending ? <button className="pi-btn pi-btn--outline" disabled={run?.status === 'starting' || run?.status === 'stopping'} onClick={() => void stop()}><Icon name="stop" size={14} />{t.stop}</button> : <button className="pi-btn pi-btn--outline" disabled={!key || !draft.trim() || loading || !!dialog} onClick={() => void send()}><Icon name="send" size={14} />{t.send}</button>}
    </footer>
  </aside>;
}
