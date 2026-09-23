import { useCallback, useState } from 'react';
import { Icon } from '../replica/Icons';
import type { PlanDocument } from './plan-document';

/**
 * 计划审批卡片（复刻 ZCode ElicitationDialog 的 plan_approval 交互）。
 * 文案、序号、页码、键盘提示均对齐 ZCode i18n（chat.permission.* / chat.elicitation.*）：
 * 头部 [需要权限] 实施计划 + 页码 1/1；选项「1. 批准 退出计划模式并开始实施。」；
 * 输入行接续序号「2. 输入你的回答...」；底部 ⓘ 键盘提示 + 忽略/提交。
 * Enter 提交（无反馈时按协议自动视为批准），Escape 忽略（留在计划模式）。
 */
export function PlanApprovalCard({ lang, executing, onApprove, onDecline }: {
  lang: 'zh' | 'en';
  executing: boolean;
  onApprove: (feedback?: string) => void;
  onDecline: (feedback?: string) => void;
}) {
  const zh = lang === 'zh';
  const [feedback, setFeedback] = useState('');
  const hasFeedback = feedback.trim().length > 0;

  const approve = useCallback(() => {
    onApprove(feedback.trim() || undefined);
    setFeedback('');
  }, [feedback, onApprove]);

  const decline = useCallback(() => {
    onDecline(feedback.trim() || undefined);
    setFeedback('');
  }, [feedback, onDecline]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.target instanceof HTMLTextAreaElement) return;
    if (event.key === 'Enter') { event.preventDefault(); approve(); }
    else if (event.key === 'Escape') { event.preventDefault(); decline(); }
  }, [approve, decline]);

  return (
    <div className="pi-plan-approval" role="dialog" aria-label={zh ? '计划审批' : 'Plan approval'} onKeyDown={handleKeyDown}>
      <div className="pi-plan-approval__body">
        <div className="pi-plan-approval__header">
          <span className="pi-plan-approval__badge">{zh ? '需要权限' : 'Permission required'}</span>
          <span className="pi-plan-approval__question">{zh ? '实施计划' : 'Implementation plan'}</span>
          <span className="pi-plan-approval__pager">
            <button type="button" className="pi-iconbtn" disabled aria-label={zh ? '上一题' : 'Previous question'}><Icon name="chevron-left" size={13} /></button>
            <span className="pi-plan-approval__pager-count">1 / 1</span>
            <button type="button" className="pi-iconbtn" disabled aria-label={zh ? '下一题' : 'Next question'}><Icon name="chevron-right" size={13} /></button>
          </span>
        </div>

        <div className="pi-plan-approval__options">
          <button type="button" className={`pi-plan-approval__option${hasFeedback ? '' : ' is-selected'}`} onClick={approve}>
            <span className={`pi-plan-approval__num${hasFeedback ? '' : ' is-on'}`}>1.</span>
            <span className="pi-plan-approval__option-label">{zh ? '批准' : 'Approve'}</span>
            <span className="pi-plan-approval__option-desc">{zh ? '退出计划模式并开始实施。' : 'Exit plan mode and start implementation.'}</span>
          </button>
          <div className={`pi-plan-approval__inputrow${hasFeedback ? ' is-selected' : ''}`}>
            <span className={`pi-plan-approval__num${hasFeedback ? ' is-on' : ''}`}>2.</span>
            <textarea
              className="pi-plan-approval__feedback"
              rows={1}
              placeholder={zh ? '输入你的回答...' : 'Enter your answer...'}
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
            />
          </div>
        </div>
      </div>

      <div className="pi-plan-approval__footer">
        <span className="pi-plan-approval__hint">
          <Icon name="info" size={14} />
          <span>{zh ? '使用 Tab / 上下键选择，回车或空格选中' : 'Use Tab / arrow keys to choose, then Enter or Space to select'}</span>
        </span>
        <span className="pi-plan-approval__actions">
          <button type="button" className="pi-btn" onClick={decline}>{zh ? '忽略' : 'Dismiss'}</button>
          <button type="button" className="pi-btn pi-btn--primary" disabled={executing} onClick={approve}>{zh ? '提交' : 'Submit'}</button>
        </span>
      </div>
    </div>
  );
}
