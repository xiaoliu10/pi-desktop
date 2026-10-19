/** Fixed UI descriptions only: never echo arbitrary backend errors or paths. */
export function transcriptErrorMessage(code: string | undefined, zh: boolean): string {
  const messages: Record<string, [string, string]> = {
    'bad-args': ['子会话转录读取参数无效。', 'Invalid child transcript request.'],
    'no-history': ['无法读取父会话历史，暂时不能定位子会话。', 'Parent history is unavailable; the child session cannot be resolved.'],
    'no-snapshot': ['尚未找到可读取的子会话转录指针（快照可能尚未发布或已清理）。', 'No readable child transcript pointer was found (snapshot not published or cleaned).'],
    'outside-sessions-root': ['子会话转录路径未通过安全校验，已拒绝读取。', 'Child transcript path failed the safety check; reading was denied.'],
    'read-failed': ['子会话转录读取失败；运行中会继续重试。', 'Child transcript could not be read; active runs will retry.'],
  };
  return (messages[code ?? ''] ?? ['子会话转录请求失败；运行中会继续重试。', 'Child transcript request failed; active runs will retry.'])[zh ? 0 : 1];
}
