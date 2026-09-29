import { useState } from 'react';
import type { ReactNode } from 'react';

/** Keep an accessible process entry even before the runtime has emitted any content. */
export function WaitingProcess({ children, zh, onRefresh }: { children: ReactNode; zh: boolean; onRefresh?: () => Promise<boolean> }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<'ok' | 'error'>();
  const refresh = async () => {
    if (busy || !onRefresh) return;
    setBusy(true);
    try { setResult(await onRefresh() ? 'ok' : 'error'); }
    catch { setResult('error'); }
    finally { setBusy(false); }
  };
  return <details className="pi-waiting-process">
    <summary>{children}<span>{zh ? '查看过程' : 'View process'}</span></summary>
    <div className="pi-waiting-process__body">
      <p>{zh ? '本轮当前没有可展示的思考或工具过程。计时依据本地任务状态，不代表已验证请求仍在运行；长上下文会话下模型首个响应可能需要较长时间，请稍候。' : 'No thinking or tool process is currently available for this turn. The timer reflects local task state, not verification that the request is still running; with long context the model may take a while before its first response.'}</p>
      {onRefresh && <button type="button" className="pi-btn pi-btn--outline" disabled={busy} onClick={() => void refresh()}>{busy ? (zh ? '正在同步…' : 'Refreshing…') : (zh ? '重新同步过程' : 'Refresh process')}</button>}
      {result && <p role="status">{result === 'error' ? (zh ? '同步失败，请稍后重试；不会重新发送任务。' : 'Refresh failed. Try again later; the task was not resent.') : (zh ? '已刷新磁盘中保存的会话内容；这不代表已验证请求仍在运行。' : 'Saved conversation content refreshed from disk; this does not verify that the request is still running.')}</p>}
    </div>
  </details>;
}
