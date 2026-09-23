import { useEffect, useMemo, useRef, useState } from 'react';
import type { SubagentChild, ChildState } from './subagents';
import { subagentTranscriptTurns } from './subagents';
import { TurnArticle } from '../replica/chat/ChatView';
import { replicaLabels } from '../replica/i18n';
import { usePiStore } from './adapter';
import { Icon } from '../replica/Icons';
import './subagents.css';

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
export function Transcript({ messages, turnKey, live }: { messages: SubagentChild['messages']; turnKey: string; live: boolean }) {
  const turns = useMemo(() => subagentTranscriptTurns(messages, turnKey), [messages, turnKey]);
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
  useEffect(() => { if (follow.current && transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight; }, [selected, active?.messages]);

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
        <Transcript messages={active.messages} turnKey={active.id} live={['running', 'queued'].includes(active.status)} />
        {!active.messages.length && <p className="pi-subagents__empty">{zh ? '插件尚未报告消息。' : 'No messages reported yet.'}</p>}
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
          <h3 className="pi-subagents__section">{zh ? '已结束' : 'Ended'} · {ended.length}</h3>
          {ended.slice(0, limit).map(c => (
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
          ))}
          {ended.length > limit && <button className="pi-btn pi-btn--ghost pi-subagents__more" onClick={() => setLimit(n => n + 30)}>{zh ? '显示更多' : 'Show more'}</button>}
          {!ended.length && !running.length && <p className="pi-subagents__sectionempty">{zh ? '暂无子代理记录。' : 'No subagent records.'}</p>}
        </section>
      </div>
    </>}

    <footer>
      <small>{zh ? '只读展示插件报告的消息；历史记录缺失时不推测运行结果。' : 'Read-only display of plugin-reported messages; missing history is not inferred.'}</small>
      {parentRunning && children.some(c => ['running', 'queued'].includes(c.status)) && <button className="pi-btn pi-btn--outline" onClick={onStop}>{zh ? '停止主任务及其子代理' : 'Stop main task and subagents'}</button>}
    </footer>
  </aside>;
}
