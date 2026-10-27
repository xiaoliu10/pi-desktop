/** 发送被 pi 内核的「压缩进行中」拒绝时：这是唯一一种「等一下就好、无需用户处理」
 *  的临时拒发，故走对话流错误卡并随恢复自动消失（用户 2026-10-27 反馈）。
 *  其他「暂不能发送」（连接数满、模型刷新中、stopUnconfirmed…）是**真实失败/需要动作**，
 *  继续走全局错误横幅，绝不能被这里吞掉（审查 P1：过宽匹配会让用户零反馈）。 */
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

/** 单行摘要：去掉 IPC 前缀（Error invoking remote method 'local-pi:prompt': Error: …），
 *  同一错误在对话流里没必要把通道名嚷给用户看。 */
export function transientSendErrorSummary(message: string): string {
  return String(message ?? '')
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^Error:\s*/, '')
    .trim();
}
