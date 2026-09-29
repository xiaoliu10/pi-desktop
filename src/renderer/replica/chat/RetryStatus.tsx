import { useEffect, useState } from 'react';
import type { ModelRetryState } from '../contracts';
import type { PiRetryGroup } from '../../../shared/pi';
import { retryPresentation } from '../../pi/model-retry';
import { ChatError } from './ChatError';
import { Icon } from '../Icons';

export function RetryStatus({ retry: inner, group, zh, onStop, stopping = false }: {
  retry?: ModelRetryState | null; group?: PiRetryGroup; zh: boolean; onStop?: () => void; stopping?: boolean;
}) {
  const { retry, visible, cancellable } = retryPresentation(group, inner, stopping);
  const [now, setNow] = useState(Date.now);
  // Absolute host deadline: a rerender/focus must not restart the backoff.
  const deadline = group?.phase === 'waiting' ? group.nextRetryAt
    : retry && (!retry.phase || retry.phase === 'waiting') ? retry.retryAt : undefined;
  useEffect(() => {
    setNow(Date.now());
    if (deadline === undefined || deadline <= Date.now()) return;
    const timer = setInterval(() => {
      const time = Date.now();
      setNow(time);
      if (time >= deadline) clearInterval(timer);
    }, 250);
    return () => clearInterval(timer);
  }, [deadline]);
  if (!visible) return null;
  const seconds = Math.max(0, Math.ceil(((deadline ?? now) - now) / 1000));
  const count = retry ? `${retry.attempt}${retry.max > 0 ? `/${retry.max}` : ''}` : '';
  const innerLabel = zh ? `正在重试请求（第 ${count} 次）` : `Retrying request (attempt ${count})`;
  const label = group ? (zh ? `Desktop 重试 · 第 ${group.group}/${group.maxGroups} 组` : `Desktop retry · group ${group.group}/${group.maxGroups}`) : innerLabel;
  const phaseLabel = group ? ({
    waiting: seconds > 0 ? (zh ? `${seconds} 秒后开始下一组` : `Next group in ${seconds}s`) : (zh ? '等待下一组开始…' : 'Waiting for next group…'),
    running: zh ? '等待模型响应…' : 'Waiting for model response…',
    completed: zh ? '任务已完成' : 'Task completed',
    exhausted: zh ? '重试组已耗尽' : 'Retry groups exhausted',
    cancelled: zh ? '任务已取消' : 'Task cancelled',
    failed: zh ? '任务失败，已停止自动重试' : 'Task failed; automatic retries stopped',
  })[group.phase] : '';
  const innerPhase = seconds > 0 ? (zh ? `${seconds} 秒后重试` : `Retrying in ${seconds}s`) : retry?.phase === 'streaming' ? (zh ? '已恢复输出…' : 'Receiving response…') : (zh ? '等待模型响应…' : 'Waiting for model response…');
  return <div className="pi-chat__retry" role="status" aria-live="polite" aria-label={label}>
    <div className="pi-chat__retry-heading">
      <Icon name="refresh" size={14} className="pi-chat__retry-icon" />
      <span>{label}</span>
      <span className="pi-chat__retry-wait" aria-live="off">{stopping ? (zh ? '正在取消…' : 'Cancelling…') : retry ? innerPhase : phaseLabel}</span>
      {onStop && (cancellable || stopping) && <button type="button" className="pi-btn pi-btn--ghost" onClick={onStop} disabled={stopping}>{zh ? '取消任务' : 'Cancel task'}</button>}
    </div>
    {group && retry && !stopping && <div>{zh ? 'CLI 内部重试 · ' : 'CLI internal retry · '}{innerLabel}</div>}
    {group?.error && ['failed', 'exhausted', 'cancelled'].includes(group.phase) && <ChatError part={{ kind: 'error', id: 'desktop-retry-error', message: group.error, details: group.error }} zh={zh} />}
  </div>;
}
