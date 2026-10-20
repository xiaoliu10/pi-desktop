import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PiHistory } from '../../shared/pi';
import { Icon } from '../replica/Icons';
import { ChatView, Composer } from '../replica/chat/ChatView';
import type { ComposerLabels } from '../replica/contracts';
import { InlineApprovalCard, InlineAskCard, isApprovalDialog, isAskDialog } from './inline-dialogs';
import { replicaLabels } from '../replica/i18n';
import type { Dialog } from './adapter';
import { conversationMessages, usePiStore } from './adapter';

/**
 * 副驾里非 ask/非审批的扩展交互兜底卡：标题 + message + 应答入口
 * （select=选项按钮；input/editor=文本框；confirm=允许/拒绝）。
 * 样式复用 pi-ask-inline 容器保持与主对话一致的外观。
 */
function FallbackDialog({ dialog, onRespond }: { dialog: Dialog; onRespond: (r: { value?: string; confirmed?: boolean; cancelled?: boolean }) => void }) {
  const s = usePiStore();
  const zh = s.lang === 'zh';
  const [text, setText] = useState(String(dialog.request.prefill ?? ''));
  const r = dialog.request;
  return <section className="pi-ask-inline" role="dialog" aria-label={String(r.title ?? '')}>
    <strong className="pi-sidecar__fb-title">{String(r.title ?? (zh ? '需要你的输入' : 'Input needed'))}</strong>
    {r.message ? <pre className="pi-sidecar__fb-msg">{String(r.message)}</pre> : null}
    {r.method === 'select'
      ? (r.options ?? []).map(option => <button className="pi-btn pi-btn--outline" key={option} onClick={() => onRespond({ value: option })}>{option}</button>)
      : r.method !== 'confirm'
        ? <textarea className="pi-sidecar__fb-input" aria-label={zh ? '回答' : 'Answer'} value={text} onChange={e => setText(e.target.value)} />
        : null}
    <div className="pi-sidecar__fb-row">
      <button className="pi-btn pi-btn--outline" onClick={() => onRespond({ cancelled: true })}>{zh ? '取消 / 拒绝' : 'Cancel / deny'}</button>
      {r.method !== 'select' && <button className="pi-btn pi-btn--outline" onClick={() => onRespond(r.method === 'confirm' ? { confirmed: true } : { value: text })}>{r.method === 'confirm' ? (zh ? '允许' : 'Allow') : (zh ? '提交' : 'Submit')}</button>}
    </div>
  </section>;
}

export function sidecarLabelsFor(lang: 'en' | 'zh') {
  return lang === 'zh'
    ? { title: '辅助对话', start: '点击开始辅助对话', hint: '独立对话 · 仅 read 工具 · 不共享主会话上下文', placeholder: '向辅助对话提问…', send: '发送', stop: '停止', close: '关闭辅助对话面板', retry: '重新连接', deny: '取消 / 拒绝', allow: '允许本次', submit: '确定' }
    : { title: 'Auxiliary chat', start: 'Start an auxiliary chat', hint: 'Independent conversation · read tool only · no main context', placeholder: 'Ask the auxiliary chat…', send: 'Send', stop: 'Stop', close: 'Close auxiliary chat panel', retry: 'Reconnect', deny: 'Cancel / deny', allow: 'Allow once', submit: 'Submit' };
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
  const [historyError, setHistoryError] = useState<string>();
  const [draft, setDraft] = useState(() => { try { return localStorage.getItem(`pi.sidecarDraft:${mainKey}`) ?? ''; } catch { return ''; } });
  // 同一 mainKey 可能有两个面板实例（顶栏面板 + workbench 内嵌 tab）。草稿以 localStorage
  // 为唯一真理源：onChange 即写；实例重新可见（面板切换/tab 切回/窗口聚焦）时以存储值
  // 重同步本地 state——否则后打开的实例会拿陈旧草稿覆盖新草稿（review P1 实证丢输入）。
  const alive = useRef(true), ensuring = useRef(false);
  const run = s.runs.find(r => r.key === key);
  const busy = !!run && ['starting', 'running', 'stopping'].includes(run.status);
  const dialog = s.dialogs.find(d => d.key === key);
  const askDialog = useMemo(() => (dialog && isAskDialog(dialog) ? dialog : null), [dialog]);
  // 权限审批卡（confirm 旧协议 + select 新协议）。
  const approvalDialog = useMemo(() => (dialog && !askDialog && isApprovalDialog(dialog) && (dialog.request.method === 'confirm' || dialog.request.method === 'select') ? dialog : null), [dialog, askDialog]);
  // 其余扩展交互（input/editor/非审批 select）的最小兜底：主 UI 只渲染 selectedKey
  // 的 dialog，副驾 key 永不等同 selectedKey——没有这个兜底就全 app 无处应答
  // （review P1-2，旧代码的 textarea 分支曾覆盖此路径）。
  const fallbackDialog = useMemo(() => (dialog && !askDialog && !approvalDialog ? dialog : null), [dialog, askDialog, approvalDialog]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    try {
      localStorage.setItem(`pi.sidecarDraft:${mainKey}`, draft);
      // 同页另一面板实例即时同步（原生 storage 事件不覆盖同文档写入方）。
      window.dispatchEvent(new StorageEvent('storage', { key: `pi.sidecarDraft:${mainKey}` }));
    } catch { /* Draft storage is best effort. */ }
  }, [mainKey, draft]);
  // 草稿以 localStorage 为唯一真理源；resync 同值 no-op（输入中不被存储旧值清掉）。
  const resyncDraft = useCallback(() => {
    try {
      const stored = localStorage.getItem(`pi.sidecarDraft:${mainKey}`) ?? '';
      setDraft(prev => prev === stored ? prev : stored);
    } catch { /* best effort */ }
  }, [mainKey]);
  useEffect(() => {
    const onStorage = (e: StorageEvent) => { if (e.key === `pi.sidecarDraft:${mainKey}`) resyncDraft(); };
    // 原生 storage 事件只跨文档；同页的另一个面板实例（顶栏 ↔ workbench 内嵌）由写入方
    // 手动派发同名事件同步。textarea 聚焦不做 resync——fill/键入的 focus 会抢先清输入。
    window.addEventListener('storage', onStorage);
    return () => { window.removeEventListener('storage', onStorage); };
  }, [mainKey, resyncDraft]);
  // 实例重新可见（顶栏面板 ↔ workbench aux tab 的 display 切换）时以存储值重同步，
  // 否则 keep-alive 实例拿陈旧草稿继续编辑会无痕覆盖另一实例的最新输入（review P1）。
  const asideRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = asideRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entry => { if (entry[0]?.isIntersecting) resyncDraft(); });
    observer.observe(el);
    return () => observer.disconnect();
  }, [resyncDraft]);

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
      // Only publish the key returned by ensure: a stored binding may be stale.
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
        // tail 500 与主对话同口径：不带 tail 的 history 会让 worker 回传全量 branch
        // （大会话 MB 级跨进程克隆，流式期间每 180ms 一次）；窗口是硬约束不是建议。
        const value = await window.localPi!.history(key, undefined, { tail: 500 });
        if (!cancelled) { setHistory(value); setHistoryError(undefined); }
      } catch (e) { if (!cancelled) setHistoryError(String((e as Error).message ?? e)); }
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
  // 与主对话同一条投影链路（history + live + toolProgress），副驾只是独立会话。
  const messages = useMemo(() => conversationMessages(history?.branch ?? [], live, tools), [history, live, tools]);
  // Composer 的 onSend 携带权威文本（其本地输入领先 200ms 防抖回流，不能读 draft state）。
  const send = async (text: string) => {
    if (!key || !text.trim() || busy || sending || loading || dialog) return;
    setSending(true); setError(undefined);
    try {
      const result = await window.localPi!.sidecarEnsure(mainKey); // Reattach after an idle slot eviction.
      if (!alive.current) return;
      setKey(result.key);
      await window.localPi!.prompt(result.key, text, 'followUp');
      if (alive.current) setDraft(current => current.trim() === text ? '' : current);
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

  // 主对话同款文案：Composer 的 labels 需完整结构，只在占位符上换成副驾口吻。
  const composerLabels: ComposerLabels = useMemo(() => {
    const base = replicaLabels(s.lang).composer;
    return { ...base, placeholderSession: t.placeholder, placeholderHome: t.placeholder };
  }, [s.lang, t]);

  return <aside ref={asideRef} className="pi-sidecar" aria-label={t.title} data-sidecar-key={key}>
    <header><strong><Icon name="chat" size={16} />{t.title}</strong><button className="pi-iconbtn" aria-label={t.close} onClick={onClose}><Icon name="x" size={16} /></button></header>
    <small className="pi-sidecar__hint">{t.hint}</small>
    <ChatView
      messages={messages}
      conversationKey={key ?? null}
      runTiming={run?.timing}
      running={busy}
      queued={run?.pending ?? 0}
      queue={run?.queue}
      sending={sending || run?.status === 'starting'}
      retrying={key ? s.retrying[key] ?? undefined : undefined}
      retryGroup={run?.retryGroup}
      stopping={run?.status === 'stopping'}
      onStop={() => void stop()}
      demo={false}
      labels={replicaLabels(s.lang).chat}
      onJumpToMessage={() => undefined}
    />
    {error || historyError || run?.error ? <p role="alert" className="pi-sidecar__error">{error || historyError || run?.error}</p> : null}
    {loading && !key && <p className="pi-sidecar__status" role="status">{s.lang === 'zh' ? '正在准备辅助对话…' : 'Preparing auxiliary chat…'}</p>}
    {!key && !loading && <button className="pi-btn pi-btn--outline pi-sidecar__start" onClick={() => void ensure()}>{t.start}</button>}
    {key && !loading && (!run || run.status === 'error') && <button className="pi-btn pi-btn--outline pi-sidecar__retry" onClick={() => void ensure()}>{t.retry}</button>}
    {askDialog || approvalDialog
      ? askDialog
        ? <InlineAskCard key={`${askDialog.generation}:${askDialog.request.id}`} dialog={askDialog} />
        : <InlineApprovalCard key={`${approvalDialog!.generation}:${approvalDialog!.request.id}`} dialog={approvalDialog!} />
      : fallbackDialog
        ? <FallbackDialog key={`${fallbackDialog.generation}:${fallbackDialog.request.id}`} dialog={fallbackDialog} onRespond={respond} />
        : <Composer
        key={key ?? 'pending'}
        draftText={draft}
        draftOwnerKey={null}
        onDraftChange={text => setDraft(text)}
        // busy/dialog 时 preparing=true：Composer.submit 提前 return 且不清空本地输入
        // （review P1-1：副驾运行中按 Enter，输入必须保留——主对话 busy 时是排队，
        // 副驾 send 是直接丢弃，不能沿用那套语义）。
        preparing={loading || !key || busy || sending || !!dialog}
        sessionActive={!!key}
        modelId={run?.model ? `${run.model.provider}/${run.model.id}` : ''}
        modelGroups={[]}
        reasoning="off"
        agentMode="agent"
        permissionMode="ask"
        slashCommands={[]}
        files={[]}
        running={busy}
        sending={sending}
        queued={run?.pending ?? 0}
        queue={run?.queue}
        demo={false}
        labels={composerLabels}
        hideReasoning
        modelDisabled
        onSend={text => { void send(text); }}
        onStop={() => void stop()}
        onPickModel={() => undefined}
        onPickReasoning={() => undefined}
        onPickAgentMode={() => undefined}
        onPickPermission={() => undefined}
      />}
  </aside>;
}
