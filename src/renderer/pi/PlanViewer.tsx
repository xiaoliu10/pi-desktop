import { useEffect, useRef, useState } from 'react';
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

function CopyPlanButton({ markdown, zh }: { markdown: string; zh: boolean }) {
  const [copied, setCopied] = useState(false);
  return <button type="button" className="pi-iconbtn" aria-label={copied ? (zh ? '已复制' : 'Copied') : (zh ? '复制计划' : 'Copy plan')} onClick={() => {
    if (!navigator.clipboard?.writeText) return;
    void navigator.clipboard.writeText(markdown).then(
      () => { setCopied(true); setTimeout(() => setCopied(false), 1500); },
      () => setCopied(false),
    );
  }}><Icon name={copied ? 'check' : 'copy'} size={14} /></button>;
}

export function PlanViewer({ doc, checklist, lang, running, planMode, synthesized, focusIndex, onClose, onExecute }: {
  doc: PlanDocument | null;
  checklist: PlanItem[];
  lang: 'zh' | 'en';
  running: boolean;
  planMode: boolean;
  /** doc 是由任务清单合成的（会话未走计划模式）：清单已并入文档表格，不再重复渲染。 */
  synthesized?: boolean;
  /** 从状态面板点某一行进来：打开后滚动定位到该步骤并高亮（-1/undefined = 无定位）。 */
  focusIndex?: number;
  onClose: () => void;
  onExecute?: () => void;
}) {
  const zh = lang === 'zh';
  const done = checklist.filter((item) => item.status === 'completed').length;
  // 定位：状态面板点某一行 → 打开即滚到该项并短暂高亮（用户要「点进来就能看
  // 明细」，不是给几个标题）。highlight 2.2s 后自消，避免长期染色干扰阅读。
  const listRef = useRef<HTMLOListElement | null>(null);
  // 高亮 class 由 render 决定（不用 state）：focusIndex 打开期间恒真，关闭由父组件
  // 传 undefined 清除（PiReplicaApp onClose 时清空）。scrollIntoView 是副作用，放
  // effect 里只做滚动（无 DOM 环境如 SSR 测试时静默跳过）。
  useEffect(() => {
    if (focusIndex === undefined || focusIndex < 0) return;
    const node = listRef.current?.children[focusIndex] as HTMLElement | undefined;
    if (node?.scrollIntoView) node.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [focusIndex]);
  const footer = doc
    ? synthesized
      ? zh ? '本会话未走计划模式，计划全文由任务清单合成。' : 'This session never entered plan mode; the plan is synthesized from the task checklist.'
      : planMode
        ? running
          ? zh ? '正在生成计划，内容实时更新。' : 'Plan is streaming; this view updates live.'
          : zh ? '计划已就绪，确认后即可切换到执行模式。' : 'Plan ready. Switch to execution mode to start.'
        : zh ? '显示本会话最近一次计划快照。' : 'Showing the latest plan snapshot of this session.'
    : zh ? '计划模式下助手产出计划后，可在这里查看全文。' : 'The plan document will appear here once produced in plan mode.';
  return <aside className="pi-plan-viewer" aria-label={zh ? '计划查看器' : 'Plan viewer'}>
    <header>
      <strong title={doc?.title}>{zh ? '计划' : 'Plan'}{doc?.title ? ` · ${doc.title}` : ''}</strong>
      <span className="pi-plan-viewer__actions">
        {doc && <CopyPlanButton markdown={doc.markdown} zh={zh} />}
        {planMode && !running && !synthesized && doc && onExecute && <button className="pi-btn pi-btn--primary" onClick={onExecute}>{zh ? '按计划执行' : 'Execute plan'}</button>}
        <button className="pi-iconbtn" aria-label={zh ? '关闭计划面板' : 'Close plan panel'} onClick={onClose}><Icon name="x" size={16} /></button>
      </span>
    </header>
    <div className="pi-plan-viewer__body">
      {doc ? <ChatMarkdown text={doc.markdown} /> : <p className="pi-status-hint">{zh ? '暂无计划文档。' : 'No plan document yet.'}</p>}
      {!synthesized && checklist.length > 0 && <section className="pi-plan-viewer__todo" aria-label={zh ? '任务清单' : 'Checklist'}>
        <div className="pi-plan-viewer__todo-head"><span>{zh ? '任务清单' : 'Checklist'}</span><b>{done}/{checklist.length}</b></div>
        <ol ref={listRef}>
          {checklist.map((item, index) => <li key={index} className={`is-${item.status}${focusIndex === index ? ' is-highlight' : ''}`}>
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
