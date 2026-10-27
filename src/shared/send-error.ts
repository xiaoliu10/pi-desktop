/** 发送被「临时状态」拒绝（压缩进行中、任务未收尾、重试结算中等）而不是真正失败：
 *  这类错误不需要用户处理，等一下重新发送即可。渲染层据此把它放进对话流、
 *  并在会话恢复（compaction_end / 下一轮开始 / 重发成功）后自动移除，
 *  而不是挂一条永不消失的全局错误横幅（用户 2026-10-27 反馈）。
 *  匹配口径：pi 内核与 Desktop backend 的固定文案集合，两边新增文案都要同步这里。 */
const TRANSIENT_PATTERNS: RegExp[] = [
  // pi 内核：Cannot submit a prompt while compaction is in progress.
  /cannot submit a prompt while compaction is in progress/i,
  /compaction is in progress/i,
  // Desktop backend 的发送前置校验（backend.ts prompt/assertResendable）。
  /当前会话暂不能发送/,
  /退出流程|正在退出/,
  /请稍候|稍后再试/,
];

/** 是否属于「等会话空闲后重发即可」的临时拒发错误。null/空串一律 false。 */
export function isTransientSendError(message: string | null | undefined): boolean {
  const text = String(message ?? '').trim();
  if (!text) return false;
  return TRANSIENT_PATTERNS.some(pattern => pattern.test(text));
}

/** 单行摘要：去掉 IPC 前缀（Error invoking remote method 'local-pi:prompt': Error: …），
 *  同一错误在对话流里没必要把通道名嚷给用户看。保留原始 detail 供错误卡展开。 */
export function transientSendErrorSummary(message: string): string {
  return String(message ?? '')
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^(?:Error|ErrorErrorException):\s*/, '')
    .trim();
}
