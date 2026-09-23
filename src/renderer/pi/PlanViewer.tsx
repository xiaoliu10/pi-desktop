import { ChatMarkdown } from '../replica/chat/ChatView';
import { Icon } from '../replica/Icons';
import type { PlanItem } from '../../shared/conversation-status';
import type { PlanDocument } from './plan-document';

/**
 * 计划查看器（复刻 ZCode PlanDetailSidePane）：右侧面板实时渲染计划文档
 * （流式期间跟随更新），附任务清单进度。ZCode 用会话投影按 toolCallId
 * 实时重提取；Desktop 的计划文档本就派生自 messages，由父组件计算传入。
 */

const statusIcon = { completed: 'check-circle', in_progress: 'refresh', pending: 'circle' } as const;
const statusLabel = {
  completed: { zh: '已完成', en: 'completed' },
  in_progress: { zh: '进行中', en: 'in progress' },
  pending: { zh: '待处理', en: 'pending' },
} as const;

export function PlanViewer({ doc, checklist, lang, running, planMode, onClose, onExecute }: {
  doc: PlanDocument | null;
  checklist: PlanItem[];
  lang: 'zh' | 'en';
  running: boolean;
  planMode: boolean;
  onClose: () => void;
  onExecute?: () => void;
}) {
  const zh = lang === 'zh';
  const done = checklist.filter((item) => item.status === 'completed').length;
  const footer = doc
    ? planMode
      ? running
        ? zh ? '正在生成计划，内容实时更新。' : 'Plan is streaming; this view updates live.'
        : zh ? '计划已就绪，确认后即可切换到执行模式。' : 'Plan ready. Switch to execution mode to start.'
      : zh ? '显示本会话最近一次计划快照。' : 'Showing the latest plan snapshot of this session.'
    : zh ? '计划模式下助手产出计划后，可在这里查看全文。' : 'The plan document will appear here once produced in plan mode.';
  return <aside className="pi-plan-viewer" aria-label={zh ? '计划查看器' : 'Plan viewer'}>
    <header>
      <strong title={doc?.title}>{zh ? '计划' : 'Plan'}{doc?.title ? ` · ${doc.title}` : ''}</strong>
      <span className="pi-plan-viewer__actions">
        {planMode && !running && doc && onExecute && <button className="pi-btn pi-btn--primary" onClick={onExecute}>{zh ? '按计划执行' : 'Execute plan'}</button>}
        <button className="pi-iconbtn" aria-label={zh ? '关闭计划面板' : 'Close plan panel'} onClick={onClose}><Icon name="x" size={16} /></button>
      </span>
    </header>
    <div className="pi-plan-viewer__body">
      {doc ? <ChatMarkdown text={doc.markdown} /> : <p className="pi-status-hint">{zh ? '暂无计划文档。' : 'No plan document yet.'}</p>}
      {checklist.length > 0 && <section className="pi-plan-viewer__todo" aria-label={zh ? '任务清单' : 'Checklist'}>
        <div className="pi-plan-viewer__todo-head"><span>{zh ? '任务清单' : 'Checklist'}</span><b>{done}/{checklist.length}</b></div>
        <ol>
          {checklist.map((item, index) => <li key={index} className={`is-${item.status}`}>
            <Icon name={statusIcon[item.status]} size={13} />
            <span>{item.step}</span>
            <small>{statusLabel[item.status][lang]}</small>
          </li>)}
        </ol>
      </section>}
    </div>
    <footer><small>{footer}</small></footer>
  </aside>;
}
