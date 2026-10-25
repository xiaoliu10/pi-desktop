import type { ModelRetryState } from '../replica/contracts';
import type { PiRetryGroup } from '../../shared/pi';
import { hasModelOutput } from '../../shared/model-output';
import { redactDiagnosticText } from '../../../extensions/desktop-policy/diagnostic-text.mjs';

/** Presentation only: the renderer never advances groups or replenishes their budget. */
export function retryPresentation(group?: PiRetryGroup, inner?: ModelRetryState | null, stopping = false) {
  const activeGroup = group?.phase === 'waiting' || group?.phase === 'running';
  // 任务已落定（完成/用户取消）：横幅必须随任务退场——结果以对话内容为准，
  // 残留「Desktop 重试 · 第 N 组」会被读成仍在重试（实测用户反馈）。
  // failed/exhausted 保留：它们是最终错误原因与脱敏详情的唯一展示位。
  const settled = group?.phase === 'completed' || group?.phase === 'cancelled';
  // CLI state belongs to one group; do not leak its countdown into outer waits/terminal states.
  const retry = group && group.phase !== 'running' ? undefined : inner ?? undefined;
  // A new CLI retry overrides a previous host recovery snapshot; terminal errors stay visible.
  const outputRecovered = (!group || group.phase === 'running')
    && (retry ? retry.phase === 'streaming' : group?.outputRecovered === true);
  return {
    retry,
    visible: !outputRecovered && Boolean(!settled && group && (group.group > 1 || group.phase === 'waiting' || group.error) || retry),
    recovering: !stopping && Boolean(activeGroup || retry),
    cancellable: !stopping && Boolean(activeGroup || retry),
  };
}

export function nextModelRetryState(current: ModelRetryState | null, event: Record<string, unknown>, now: number): ModelRetryState | null {
  if (event.type === 'auto_retry_start') {
    const number = (value: unknown, fallback: number) => {
      const n = Number(value);
      return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
    };
    const delay = number(event.delayMs, 0);
    return {
      attempt: Math.max(1, number(event.attempt, 1)), max: number(event.maxAttempts, 0),
      error: redactDiagnosticText(event.errorMessage, 1500),
      retryAt: now + delay, phase: delay ? 'waiting' : 'requesting',
    };
  }
  if (event.type === 'auto_retry_end' || event.type === 'agent_settled' || event.type === 'desktop_retry_group_wait') return null;
  const message = event.message as { role?: string; stopReason?: string } | undefined;
  if (event.type === 'message_end' && message?.role === 'assistant' && message.stopReason === 'aborted') return null;
  if (current && hasModelOutput(event) && current.phase !== 'streaming') return { ...current, phase: 'streaming' };
  // Empty stream starts also occur on failed requests; only pi's terminal retry event settles them.
  if (current && event.type === 'message_start' && message?.role === 'assistant' && current.phase === 'waiting') {
    return { ...current, phase: 'requesting' };
  }
  return current;
}
