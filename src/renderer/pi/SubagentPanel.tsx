import { useEffect, useMemo, useRef, useState } from 'react';
import type { SubagentChild, ChildState } from './subagents';
import { subagentTranscriptTurns } from './subagents';
import { Spinner, TurnArticle } from '../replica/chat/ChatView';
import { replicaLabels } from '../replica/i18n';
import { usePiStore } from './adapter';
import { Icon } from '../replica/Icons';
import './subagents.css';

/** 转录缓存键版本号：模块级单调递增，同毫秒重复拉取/时钟回拨都不会碰撞。 */
let transcriptEpochSeq = 0;
const nextTranscriptEpoch = () => ++transcriptEpochSeq;

const labels: Record<ChildState, string> = {
  running: '执行中', queued: '等待执行', completed: '已完成', failed: '失败',
  interrupted: '已中断', unknown: '状态未确认', skipped: '未执行', recovered: '已从磁盘恢复',
};

/** Status icon per state (照 ZCode DirectoryRow: spinner/pause/check/alert/ban). */
function StatusIcon({ status }: { status: ChildState }) {
  if (['running', 'queued'].includes(status))
    return <Icon name="loader" size={16} className="pi-subagent-statusicon pi-subagent-statusicon--spin" />;
  if (status === 'completed') return <Icon name="check-circle" size={16} className="pi-subagent-statusicon pi-subagent-statusicon--ok" />;
  if (status === 'failed') return <Icon name="warning" size={16} className="pi-subagent-statusicon pi-subagent-statusicon--err" />;
  if (status === 'interrupted') return <Icon name="x" size={16} className="pi-subagent-statusicon pi-subagent-statusicon--warn" />;
  if (status === 'recovered') return <Icon name="refresh" size={16} className="pi-subagent-statusicon pi-subagent-statusicon--warn" />;
  return <Icon name="circle" size={16} className="pi-subagent-statusicon" />;
}

/** 转录直接复用主对话的轮次 UI（ToolCard 工具行 / ExecutionNote 思考行 / 执行过程折叠）。 */
export function Transcript({ messages, turnKey, live, epoch }: { messages: SubagentChild['messages']; turnKey: string; live: boolean; epoch?: number }) {
  const turns = useMemo(() => subagentTranscriptTurns(messages, turnKey, epoch), [messages, turnKey, epoch]);
  const chatLabels = usePiStore(s => replicaLabels(s.lang).chat);
  return <>{turns.map((turn, i) => <TurnArticle key={turn.id} m={turn} liveTurn={live && i === turns.length - 1} labels={chatLabels} />)}</>;
}

export function SubagentPanel({ children, initialCall, onClose, onStop, parentRunning }: {
  children: SubagentChild[]; initialCall?: string; onClose: () => void; onStop: () => void; parentRunning: boolean;
}) {
  const s = usePiStore();
  const zh = s.lang === 'zh';
  const [selected, setSelected] = useState<string | undefined>(() => children.find(c => c.callId === initialCall)?.id);
  const [limit, setLimit] = useState(30);
  const active = children.find(c => c.id === selected);
  const transcript = useRef<HTMLDivElement>(null), follow = useRef(true);
  useEffect(() => { follow.current = true; }, [selected]);

  // 插件不报消息的 workflow/异步子任务：按需拉子会话转录（主进程已验证身份链 +
  // containment）。单请求在途，完成后再排下轮（慢请求不饿死、也不会乱序覆盖）。
  const [fetched, setFetched] = useState<Record<string, { messages: Record<string, unknown>[]; truncated: boolean; state: 'loading' | 'ok' | 'error'; epoch: number }>>({});
  const activeId = active?.id, activeChildKey = active?.childKey, activeCallId = active?.callId, activeStatus = active?.status;
  const pluginMessages = Boolean(active?.messages.length);
  useEffect(() => {
    if (!activeId || !activeChildKey || !activeCallId || pluginMessages || !s.selectedKey) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    const load = async () => {
      if (stopped || inFlight) return;
      inFlight = true;
      try {
        const res = await window.localPi?.subagentChildTranscript(s.selectedKey!, activeCallId, activeChildKey);
        if (stopped) return;
        setFetched(prev => ({ ...prev, [activeId]: 'error' in res ? { messages: [], truncated: false, state: 'error', epoch: 0 } : { messages: res.messages, truncated: res.truncated, state: 'ok', epoch: nextTranscriptEpoch() } }));
      } catch {
        if (!stopped) setFetched(prev => ({ ...prev, [activeId]: { messages: [], truncated: false, state: 'error', epoch: 0 } }));
      } finally {
        inFlight = false;
        if (!stopped && ['running', 'queued'].includes(activeStatus || '')) timer = setTimeout(() => { void load(); }, 3000);
      }
    };
    void load();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [activeId, activeChildKey, activeCallId, activeStatus, pluginMessages, s.selectedKey]);
  const shown = active ? (active.messages.length ? active.messages : fetched[active.id]?.messages ?? []) : [];
  const fetchedState = active ? fetched[active.id] : undefined;
  useEffect(() => { if (follow.current && transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight; }, [selected, shown, active?.status]);

  const running = children.filter(c => ['running', 'queued'].includes(c.status));
  const ended = children.filter(c => !['running', 'queued'].includes(c.status));

  return <aside className="pi-subagents" aria-label={zh ? '子代理监控' : 'Subagent monitor'}>
    <header>
      <strong>{active ? (zh ? '子代理详情' : 'Subagent detail') : (zh ? '子代理目录' : 'Subagent directory')}</strong>
      <button className="pi-iconbtn" aria-label={zh ? '关闭子代理面板' : 'Close subagent panel'} onClick={onClose}><Icon name="x" size={16} /></button>
    </header>

    {active ? <>
      <button className="pi-btn pi-btn--ghost pi-subagents__back" onClick={() => setSelected(undefined)}>
        <Icon name="chevron-left" size={14} />{zh ? '返回目录' : 'Back to directory'}
      </button>
      <div className="pi-subagents__meta">
        <div className="pi-subagents__metahead">
          <StatusIcon status={active.status} />
          <h3>{active.agent}</h3>
          <span className="pi-subagents__metastatus" data-status={active.status}>{labels[active.status]}</span>
        </div>
        <p className="pi-subagents__metatask">{active.task}</p>
        <div className="pi-subagents__metastats">
          <span>{active.model || (zh ? '模型未报告' : 'Model not reported')}</span>
          <span>·</span>
          <span>{active.mode}</span>
          {active.tokens !== undefined && <><span>·</span><span>{active.tokens.toLocaleString()} tokens</span></>}
          {active.turns !== undefined && <><span>·</span><span>{active.turns} {zh ? '轮' : 'turns'}</span></>}
          {active.cost !== undefined && <><span>·</span><span>${active.cost.toFixed(4)}</span></>}
        </div>
      </div>
      <div className="pi-subagents__transcript" ref={transcript} onScroll={e => { const el = e.currentTarget; follow.current = el.scrollHeight - el.clientHeight - el.scrollTop < 48; }}>
        {active.error && <p className="pi-subagents__error" role="alert">{active.error}</p>}
        <Transcript messages={shown} turnKey={active.id} epoch={fetchedState?.epoch} live={['running', 'queued'].includes(active.status)} />
        {!shown.length && (active.childKey
          ? <p className="pi-subagents__empty">{fetchedState?.state === 'error' ? (zh ? '子会话转录不可用（快照已清理或尚未产生）。' : 'Child transcript unavailable (snapshot cleaned or not produced yet).') : fetchedState?.state === 'ok' ? (zh ? '子会话暂无消息。' : 'No messages in this child session.') : (zh ? '正在读取子会话转录…' : 'Loading child transcript…')}</p>
          : <p className="pi-subagents__empty">{zh ? '插件尚未报告消息。' : 'No messages reported yet.'}</p>)}
        {fetchedState?.truncated && shown.length > 0 && <p className="pi-subagents__empty">{zh ? '仅显示最近消息，更早内容已省略。' : 'Showing recent messages only; older content omitted.'}</p>}
        {/* Activity is owned by child state, never by transcript presence or parent activity. */}
        {['running', 'queued'].includes(active.status) && <div className="pi-subagents__working" role="status">
          <Spinner /><span>{zh ? '正在工作' : 'Working'}{active.status === 'queued' ? (zh ? ' · 等待执行' : ' · Waiting to start') : ''}</span>
        </div>}
      </div>
    </> : <>
      <div className="pi-subagents__list">
        <section>
          <h3 className="pi-subagents__section">{zh ? '运行中' : 'Running'} · {running.length}</h3>
          {running.length > 0 ? running.map(c => (
            <button className="pi-subagent-row" key={c.id} onClick={() => setSelected(c.id)}>
              <span className="pi-subagent-row__icon"><StatusIcon status={c.status} /></span>
              <span className="pi-subagent-row__body">
                <span className="pi-subagent-row__title">
                  <span className="pi-subagent-row__name">{c.agent}</span>
                  <span className="pi-subagent-row__status" data-status={c.status}>{labels[c.status]}</span>
                </span>
                {c.task && <span className="pi-subagent-row__summary">{c.task}</span>}
              </span>
            </button>
          )) : <p className="pi-subagents__sectionempty">{zh ? '暂无运行中的子代理。' : 'No running subagents.'}</p>}
        </section>

        <section className="pi-subagents__ended">
          <div className="pi-subagents__sectionhead">
            <h3 className="pi-subagents__section">{zh ? '已结束' : 'Ended'} · {ended.length}</h3>
            {ended.length > 0 && <button className="pi-subagents__clear" onClick={() => s.dismissFinishedSubagents(ended.map(c => c.id))}>{zh ? '清空' : 'Clear all'}</button>}
          </div>
          {ended.slice(0, limit).map(c => (
            <div className="pi-subagent-row pi-subagent-row--ended" key={c.id} role="button" tabIndex={0} onClick={() => setSelected(c.id)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelected(c.id); } }}>
              <span className="pi-subagent-row__icon"><StatusIcon status={c.status} /></span>
              <span className="pi-subagent-row__body">
                <span className="pi-subagent-row__title">
                  <span className="pi-subagent-row__name">{c.agent}</span>
                  <span className="pi-subagent-row__status" data-status={c.status}>{labels[c.status]}</span>
                </span>
                {c.task && <span className="pi-subagent-row__summary">{c.task}</span>}
              </span>
              <button className="pi-subagent-row__remove" title={zh ? '从列表移除' : 'Remove from list'} aria-label={zh ? '从列表移除' : 'Remove from list'} onClick={(e) => { e.stopPropagation(); s.dismissSubagent(c.id); }}>
                <Icon name="x" size={13} />
              </button>
            </div>
          ))}
          {ended.length > limit && <button className="pi-btn pi-btn--ghost pi-subagents__more" onClick={() => setLimit(n => n + 30)}>{zh ? '显示更多' : 'Show more'}</button>}
          {!ended.length && !running.length && <p className="pi-subagents__sectionempty">{zh ? '暂无子代理记录。' : 'No subagent records.'}</p>}
        </section>
      </div>
    </>}

    <footer>
      <small>{zh ? '只读展示插件消息或子会话转录；历史记录缺失时不推测运行结果。' : 'Read-only display of plugin messages or the child session transcript; missing history is not inferred.'}</small>
      {parentRunning && children.some(c => ['running', 'queued'].includes(c.status)) && <button className="pi-btn pi-btn--outline" onClick={onStop}>{zh ? '停止主任务及其子代理' : 'Stop main task and subagents'}</button>}
    </footer>
  </aside>;
}
