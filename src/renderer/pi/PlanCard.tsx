import { useCallback, useState } from 'react';
import { ChatMarkdown } from '../replica/chat/ChatView';
import { Icon } from '../replica/Icons';
import type { PlanDocument } from './plan-document';

/**
 * 计划预览卡（复刻 ZCode SwitchModeToolCallBlock）：notepad 图标 + 标题 + 复制，
 * 正文限高渐隐，底部居中「查看全文」胶囊按钮打开计划侧板。整卡可点开全文。
 */
export function PlanCard({ doc, lang, onViewPlan }: {
  doc: PlanDocument;
  lang: 'zh' | 'en';
  onViewPlan: () => void;
}) {
  const zh = lang === 'zh';
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    if (!navigator.clipboard?.writeText) return;
    void navigator.clipboard.writeText(doc.markdown).then(
      () => { setCopied(true); setTimeout(() => setCopied(false), 1500); },
      () => setCopied(false),
    );
  }, [doc.markdown]);

  return (
    <section className="pi-plan-card" role="button" tabIndex={0} aria-label={zh ? '查看全文' : 'View full plan'}
      onClick={onViewPlan}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onViewPlan(); } }}>
      <header className="pi-plan-card__head" onClick={(e) => e.stopPropagation()}>
        <Icon name="notepad" size={16} />
        <h3>{zh ? '计划' : 'Plan'}</h3>
        <button type="button" className="pi-iconbtn" aria-label={copied ? (zh ? '已复制' : 'Copied') : (zh ? '复制' : 'Copy')} onClick={copy}>
          <Icon name={copied ? 'check' : 'copy'} size={14} />
        </button>
      </header>
      <div className="pi-plan-card__body">
        <div className="pi-plan-card__markdown"><ChatMarkdown text={doc.markdown} /></div>
        <button type="button" className="pi-plan-card__viewfull" onClick={(e) => { e.stopPropagation(); onViewPlan(); }}>
          {zh ? '查看全文' : 'View full plan'}
          <Icon name="arrow-right" size={14} />
        </button>
      </div>
    </section>
  );
}
