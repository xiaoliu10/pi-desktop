import type { AccessMode } from './access-mode';
import type { ThinkingLevel } from './composer';
export type Schedule = {kind:'once';at:number} | {kind:'interval';minutes:number} | {kind:'cron';expression:string};
export interface WorkflowParameter { name:string; description:string; type:'string'|'number'|'boolean'|'json'; required:boolean; defaultValue?:string }
export interface WorkflowStep { id:string; name:string; prompt:string }
export interface SavedWorkflow { id:string; name:string; description:string; whenToUse:string; scope:'global'|'project'; cwd:string; parameters:WorkflowParameter[]; steps:WorkflowStep[]; updatedAt:number }
export interface AutomationTask { id:string; name:string; cwd:string; prompt:string; workflowId?:string; args:Record<string,string>; model?:string; thinking?:ThinkingLevel; permission:AccessMode; schedule:Schedule; enabled:boolean; maxRuns?:number; endAt?:number; runCount:number; nextRunAt?:number; lastRunAt?:number; updatedAt:number }
export type AutomationStatus = 'running'|'waiting'|'succeeded'|'failed'|'stopped'|'interrupted'|'skipped';
export interface AutomationRun { id:string; taskId?:string; workflowId?:string; name:string; cwd:string; trigger:'manual'|'schedule'; status:AutomationStatus; startedAt:number; endedAt?:number; scheduledAt?:number; sessionKey?:string; error?:string; stepIndex:number; steps:{name:string;status:'pending'|'running'|'succeeded'|'failed'|'stopped'}[] }
export interface AutomationSnapshot { tasks:AutomationTask[]; workflows:SavedWorkflow[]; runs:AutomationRun[] }
export interface WorkflowLaunch { id:string; cwd:string; args:Record<string,string>; permission:AccessMode; model?:string; thinking?:ThinkingLevel }
