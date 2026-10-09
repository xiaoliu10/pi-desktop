import type { AccessMode } from './access-mode';
import type { ThinkingLevel } from './composer';
export type Schedule = {kind:'once';at:number} | {kind:'interval';minutes:number} | {kind:'cron';expression:string};
export interface WorkflowParameter { name:string; description:string; type:'string'|'number'|'boolean'|'json'; required:boolean; defaultValue?:string }
export interface WorkflowStep { id:string; name:string; prompt:string }
export interface SavedWorkflow { id:string; name:string; description:string; whenToUse:string; scope:'global'|'project'; cwd:string; parameters:WorkflowParameter[]; steps:WorkflowStep[]; updatedAt:number }
export interface AutomationTask { id:string; name:string; cwd:string; prompt:string; workflowId?:string; args:Record<string,string>; model?:string; thinking?:ThinkingLevel; permission:AccessMode; schedule:Schedule; enabled:boolean; maxRuns?:number; endAt?:number; runCount:number; nextRunAt?:number; lastRunAt?:number; updatedAt:number; /** 执行会话：reuse=复用项目下最近活跃会话（默认，上下文连续）；fresh=每次独立新会话（历史隔离）。 */
  sessionMode?: 'reuse' | 'fresh' }
export type AutomationStatus = 'running'|'waiting'|'succeeded'|'failed'|'stopped'|'interrupted'|'skipped';
export interface AutomationRun { id:string; taskId?:string; workflowId?:string; name:string; cwd:string; trigger:'manual'|'schedule'; status:AutomationStatus; startedAt:number; endedAt?:number; scheduledAt?:number; sessionKey?:string; reusedSession?:boolean; error?:string; stepIndex:number; steps:{name:string;status:'pending'|'running'|'succeeded'|'failed'|'stopped'}[] }
export interface AutomationSnapshot { tasks:AutomationTask[]; workflows:SavedWorkflow[]; runs:AutomationRun[] }

/** 任务是否已结束（再无下次执行）：once 已触发、达到执行次数上限或过截止时间。
 *  手动暂停（enabled=false 但仍有下次执行时间）不算结束。UI 据此展示完成态
 *  （灰色卡片 + 「已结束」徽标替换开关，同 ZCode）；服务端在触发后已把这类任务 enabled=false。 */
export function taskFinished(task: Pick<AutomationTask, 'nextRunAt' | 'maxRuns' | 'runCount' | 'endAt'>, now: number = Date.now()): boolean {
  return task.nextRunAt === undefined || task.nextRunAt === null
    || (task.maxRuns !== undefined && task.runCount >= task.maxRuns)
    || (task.endAt !== undefined && task.endAt <= now);
}
export interface WorkflowLaunch { id:string; cwd:string; args:Record<string,string>; permission:AccessMode; model?:string; thinking?:ThinkingLevel }

/** 工作流步骤 prompt 的参数替换。主进程执行与 UI 乐观预览共用同一份逻辑。 */
export function workflowPrompts(workflow: SavedWorkflow, args: Record<string, string>): string[] {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw Error('工作流参数无效');
  const values = new Map<string, string>();
  for (const p of workflow.parameters) {
    const v = args[p.name] ?? p.defaultValue ?? '';
    if (typeof v !== 'string' || v.length > 10000) throw Error(`参数 ${p.name} 无效`);
    if (p.required && !v.trim()) throw Error(`请填写参数 ${p.name}`);
    if (v) {
      if (p.type === 'number' && !Number.isFinite(Number(v))) throw Error(`${p.name} 必须为数字`);
      if (p.type === 'boolean' && !['true', 'false'].includes(v)) throw Error(`${p.name} 必须为 true 或 false`);
      if (p.type === 'json') { try { JSON.parse(v); } catch { throw Error(`${p.name} 必须为有效 JSON`); } }
    }
    values.set(p.name, v);
  }
  return workflow.steps.map(s => s.prompt.replace(/\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}/g, (_, key) => values.get(key) ?? ''));
}

/** 自动化发给 pi 的完整消息文本（execute 与乐观预览共用，保证预览与实际发送一致）。 */
export function automationPromptText(name: string, stepName: string, index: number, total: number, prompt: string): string {
  return `自动化：${name}\n步骤 ${index}/${total}：${stepName}\n\n${prompt}`;
}
