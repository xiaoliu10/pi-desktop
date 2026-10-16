import type { PiModelCatalog } from '../../shared/pi';
/** Disk save and live adoption are separate facts; a failed/pending reload is not success. */
export function modelSaveNotice(result: PiModelCatalog, title: string): { kind: 'success' | 'info' | 'error'; title: string; body: string } {
  const refresh = result.sessionRefresh;
  if (refresh?.failed) return { kind: 'error', title: `${title}，但会话刷新失败`, body: result.warning ?? '配置已写入；请检查会话提示并刷新模型列表，或断开后重连。' };
  if (refresh?.pending) return { kind: 'info', title, body: `配置已写入；${refresh.pending} 个会话将在任务、交互和队列结束后的安全空闲时刷新，当前请求不受影响。` };
  return { kind: 'success', title, body: refresh?.refreshed ? `配置已写入；${refresh.refreshed} 个已连接会话已刷新并回读模型与思考等级。` : '配置已写入；新建会话使用此配置。' };
}
