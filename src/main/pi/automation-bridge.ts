import type { AccessMode } from '../../shared/access-mode';
import type { AutomationTask } from '../../shared/automation';

/** Narrow surface of AutomationService the bridge needs (type-only: avoids a cycle). */
export interface AutomationBridgeService {
  saveTask(task: AutomationTask): AutomationTask;
  deleteTask(id: string): void;
  snapshot(): { tasks: AutomationTask[] };
}

export interface AutomationBridgeContext { cwd: string; permission: AccessMode; stopping?: boolean }

/** 工具参数用友好名（autoedit/full），落库用 AccessMode 内部值（autoEdit/fullAccess）。 */
const ORDER = ['ask', 'autoEdit', 'fullAccess'] as const;
type ExecPermission = (typeof ORDER)[number];
const ALIAS: Record<string, ExecPermission> = { ask: 'ask', autoedit: 'autoEdit', autoEdit: 'autoEdit', full: 'fullAccess', fullAccess: 'fullAccess' };

/** 注入每个 desktop 会话系统提示的调度守则：工具描述 alone 不够——模型在长对话惯性里
 *  会沿用「sleep 等待」等会话内手段（2026-10-04 真实案例：发版任务被 ssh sleep 方案绕过）。 */
export const SCHEDULE_GUIDANCE = '定时/周期任务：当用户要求在特定时间或按周期执行任务（例如「今晚 22:00 发布」「每天 9 点检查」「今天 12:00-13:00 窗口发版」），必须使用 desktop_schedule 工具创建 Desktop 定时任务——任务由 Desktop 调度器在全新会话中执行，不依赖当前会话存活。不要用 sleep、后台轮询或服务器端定时器在会话内等待未来时间点（会话退出即丢失）；把到点要执行的完整操作写成自包含的任务 prompt。';

/** Agent-facing scheduled-task bridge: the desktop_schedule tool encodes its request
 *  into a reserved ui.input payload; the backend hands it here. Tasks land in
 *  automations.json and fire in a brand-new session later — surviving this session.
 *  护栏：任务权限永远不高于创建它的会话（防无人值守提权）。此函数绝不抛错。 */
export function runAutomationBridge(service: AutomationBridgeService | undefined, context: AutomationBridgeContext, payloadRaw: string): Record<string, unknown> {
  try {
    if (context.stopping) return { ok: false, error: '会话正在停止，无法操作定时任务' };
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(payloadRaw); } catch { return { ok: false, error: '请求格式无效' }; }
    const action = payload.action;
    if (action === 'list') {
      return { ok: true, action, tasks: (service?.snapshot().tasks ?? []).map(t => ({ id: t.id, name: t.name, schedule: t.schedule, enabled: t.enabled, nextRunAt: t.nextRunAt, lastRunAt: t.lastRunAt, runCount: t.runCount })) };
    }
    if (!service) return { ok: false, error: '自动化服务不可用' };
    if (action === 'create') {
      const current: ExecPermission = context.permission === 'plan' ? 'ask' : context.permission;
      const requested = typeof payload.permission === 'string' && ALIAS[payload.permission] ? ALIAS[payload.permission] : current;
      const permission = ORDER.indexOf(requested) > ORDER.indexOf(current) ? current : requested;
      const name = typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim().slice(0, 100) : '会话定时任务';
      const task = service.saveTask({ cwd: context.cwd, name, prompt: String(payload.prompt ?? ''), schedule: payload.schedule, permission, enabled: true } as AutomationTask);
      return { ok: true, action, task: { id: task.id, name: task.name, permission: task.permission, schedule: task.schedule, nextRunAt: task.nextRunAt } };
    }
    if (action === 'cancel') {
      service.deleteTask(String(payload.id ?? ''));
      return { ok: true, action };
    }
    return { ok: false, error: 'action 只支持 create / list / cancel' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
