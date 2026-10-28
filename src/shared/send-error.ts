/** 发送被「临时状态」拒绝的判定：**只**认 pi 内核的「压缩进行中」这一类。
 *  命中后 Desktop 完全静默处理（不写全局横幅、不写对话流错误卡，正文退回输入框，
 *  压缩结束后用户自行重发）——用户 2026-10-28 反馈：连错误卡也取消。
 *  连接数满/模型刷新中/停止未确认/进程退出/鉴权/网络等都是**真实失败**，
 *  一律继续走全局错误横幅，不得被这里吞掉（审查 P1）。 */
export type TransientSendErrorKind = 'compaction';

const COMPACTION_RE = /cannot submit a prompt while compaction is in progress|compaction is in progress/i;

/** 返回命中的临时拒发原因；未命中返回 null。null/空串一律 null。 */
export function classifyTransientSendError(message: string | null | undefined): TransientSendErrorKind | null {
  const text = String(message ?? '').trim();
  if (!text) return null;
  return COMPACTION_RE.test(text) ? 'compaction' : null;
}

/** 是否属于「等压缩结束后重发即可」的临时拒发错误。 */
export function isTransientSendError(message: string | null | undefined): boolean {
  return classifyTransientSendError(message) !== null;
}
