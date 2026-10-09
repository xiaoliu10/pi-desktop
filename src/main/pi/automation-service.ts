import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Cron } from 'croner';
import type { PiBackend } from './backend';
import type { SessionIndex } from './session-index';
import { canonical } from './session-index';
import type { PiEvent } from '../../shared/pi';
import { isAccessMode } from '../../shared/access-mode';
import { THINKING_LEVELS } from '../../shared/composer';
import type { AutomationSnapshot, AutomationTask, AutomationRun, SavedWorkflow, Schedule, WorkflowLaunch } from '../../shared/automation';
import { automationPromptText, workflowPrompts } from '../../shared/automation';
const live = (r:AutomationRun) => r.status==='running'||r.status==='waiting';
const str = (v:unknown,max:number,label:string,empty=false):string => {if(typeof v!=='string'||v.length>max||(!empty&&!v.trim()))throw Error(`${label}无效`);return v.trim();};
function directory(v:unknown) {const p=str(v,4096,'项目目录');if(!path.isAbsolute(p)||!fs.statSync(p).isDirectory())throw Error('请选择有效的本地项目目录');return fs.realpathSync(p);}
export function nextSchedule(schedule:Schedule,from:number):number|undefined {
 if(schedule.kind==='once'){if(!Number.isFinite(schedule.at))throw Error('执行时间无效');return schedule.at>from?schedule.at:undefined;}
 if(schedule.kind==='interval'){if(!Number.isInteger(schedule.minutes)||schedule.minutes<1||schedule.minutes>525600)throw Error('间隔必须为 1–525600 分钟');return from+schedule.minutes*60000;}
 if(schedule.kind!=='cron'||typeof schedule.expression!=='string'||schedule.expression.trim().split(/\s+/).length!==5)throw Error('请输入五段 Cron 表达式');
 const cron=new Cron(schedule.expression);try{return cron.nextRun(new Date(from))?.getTime();}finally{cron.stop();}
}
export function validateWorkflow(input:SavedWorkflow):SavedWorkflow {
 const name=str(input.name,100,'名称'),scope=input.scope;
 if(!['project','global'].includes(scope))throw Error('工作流作用域无效');
 if(!Array.isArray(input.steps)||!input.steps.length||input.steps.length>30)throw Error('工作流需要 1–30 个步骤');
 if(!Array.isArray(input.parameters)||input.parameters.length>30)throw Error('参数数量超过限制');
 const names=new Set<string>();
 const parameters=input.parameters.map(p=>{if(!/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(p.name)||names.has(p.name))throw Error('参数名称必须唯一，以字母开头，只能包含字母、数字、下划线');names.add(p.name);if(!['string','number','boolean','json'].includes(p.type))throw Error('参数类型无效');return {name:p.name,type:p.type,description:str(p.description,1000,'参数说明',true),required:!!p.required,...(p.defaultValue!==undefined?{defaultValue:str(p.defaultValue,10000,'默认值',true)}:{})};});
 const steps=input.steps.map(s=>({id:randomUUID(),name:str(s.name,100,'步骤名称'),prompt:str(s.prompt,50000,'步骤指令')}));
 for(const step of steps)for(const token of step.prompt.matchAll(/\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}/g))if(!names.has(token[1]))throw Error(`步骤引用了未声明参数：${token[1]}`);
 return {id:input.id,name,scope,cwd:scope==='project'?directory(input.cwd):'',description:str(input.description,3000,'说明',true),whenToUse:str(input.whenToUse,3000,'适用场景',true),parameters,steps,updatedAt:Date.now()};
}
export class AutomationService {
 private data:AutomationSnapshot={tasks:[],workflows:[],runs:[]};
 private timer?:ReturnType<typeof setInterval>;
 private waiters=new Map<string,{resolve:()=>void;reject:(error:Error)=>void}>();
 private closed=false;
 private stepErrors=new Map<string,string>();
 constructor(private file:string,private backend:()=>PiBackend,private index:()=>SessionIndex,private changed:()=>void=()=>{},private now=()=>Date.now()) {
  if(fs.existsSync(file)){const parsed=JSON.parse(fs.readFileSync(file,'utf8'));if(!Array.isArray(parsed.tasks)||!Array.isArray(parsed.workflows)||!Array.isArray(parsed.runs))throw Error('自动化数据格式损坏');this.data=parsed;}
  for(const r of this.data.runs)if(live(r)){r.status='interrupted';r.error='客户端已退出，未自动重放；可查看历史并重新运行。';r.endedAt=this.now();for(const step of r.steps)if(step.status==='running')step.status='stopped';}
  this.persist();
 }
 start(){if(!this.timer){this.timer=setInterval(()=>this.tick(),10000);this.timer.unref();this.tick();}}
 suspend(){clearInterval(this.timer);this.timer=undefined;}
 snapshot(){return structuredClone(this.data);}
 private persist(){fs.mkdirSync(path.dirname(this.file),{recursive:true});const temp=this.file+'.tmp';fs.writeFileSync(temp,JSON.stringify(this.data,null,2),{mode:0o600});fs.renameSync(temp,this.file);this.changed();}
 saveWorkflow(input:SavedWorkflow){const item=validateWorkflow(input);const old=this.data.workflows.find(w=>w.id===input.id);if(input.id&&!old)throw Error('工作流不存在');if(!old&&this.data.workflows.length>=100)throw Error('最多保存 100 个工作流');item.id=old?.id||randomUUID();this.data.workflows=this.data.workflows.filter(w=>w.id!==item.id).concat(item);this.persist();return item;}
 deleteWorkflow(id:string){if(this.data.tasks.some(t=>t.workflowId===id))throw Error('请先移除引用此工作流的定时任务');if(this.data.runs.some(r=>r.workflowId===id&&live(r)))throw Error('请先停止此工作流的运行');this.data.workflows=this.data.workflows.filter(w=>w.id!==id);this.persist();}
 saveTask(input:AutomationTask){
  const old=this.data.tasks.find(t=>t.id===input.id);if(input.id&&!old)throw Error('任务不存在');if(!old&&this.data.tasks.length>=20)throw Error('最多保存 20 个定时任务');
  const cwd=directory(input.cwd),name=str(input.name,100,'名称');if(!isAccessMode(input.permission))throw Error('访问模式无效');if(input.thinking&&!THINKING_LEVELS.includes(input.thinking))throw Error('思考等级无效');if(input.model)str(input.model,500,'模型');
  if(input.maxRuns!==undefined&&(!Number.isInteger(input.maxRuns)||input.maxRuns<1||input.maxRuns>100000))throw Error('执行次数上限无效');
  if(input.endAt!==undefined&&(!Number.isFinite(input.endAt)||input.endAt<=this.now()))throw Error('截止时间必须在未来');
  const prompt=str(input.prompt,50000,'任务指令',!!input.workflowId),args=input.args||{};
  if(input.workflowId){const w=this.workflow(input.workflowId,cwd);workflowPrompts(w,args);}
  const schedule=structuredClone(input.schedule),changed=JSON.stringify(old?.schedule)!==JSON.stringify(schedule);
  const next=changed||(!old?.enabled&&input.enabled)?nextSchedule(schedule,this.now()):old?.nextRunAt;
  if(input.enabled&&(!next||input.endAt&&next>input.endAt))throw Error('调度规则在截止时间前没有未来执行时间');
  const sessionMode=input.sessionMode==='fresh'?'fresh':'reuse';
  const item:AutomationTask={id:old?.id||randomUUID(),name,cwd,prompt,workflowId:input.workflowId||undefined,args,model:input.model||undefined,thinking:input.thinking,permission:input.permission,schedule,enabled:!!input.enabled,maxRuns:input.maxRuns,endAt:input.endAt,runCount:old?.runCount||0,nextRunAt:next,lastRunAt:old?.lastRunAt,updatedAt:this.now(),sessionMode};
  this.data.tasks=this.data.tasks.filter(t=>t.id!==item.id).concat(item);this.persist();return item;
 }
 toggle(id:string){const task=this.task(id);if(task.enabled){task.enabled=false;}else{if(task.maxRuns&&task.runCount>=task.maxRuns)throw Error('已达到执行次数上限，请编辑上限');const next=nextSchedule(task.schedule,this.now());if(!next||task.endAt&&next>task.endAt)throw Error('调度已结束，请编辑执行时间');task.enabled=true;task.nextRunAt=next;}this.persist();}
 deleteTask(id:string){if(this.data.runs.some(r=>r.taskId===id&&live(r)))throw Error('请先停止此任务的运行');this.data.tasks=this.data.tasks.filter(t=>t.id!==id);this.persist();}
 private task(id:string){const t=this.data.tasks.find(t=>t.id===id);if(!t)throw Error('任务不存在');return t;}
 private workflow(id:string,cwd:string){const w=this.data.workflows.find(w=>w.id===id);if(!w)throw Error('工作流不存在');if(w.scope==='project'&&w.cwd!==cwd)throw Error('该工作流只适用于所属项目');return w;}
 runTask(id:string,trigger:'manual'|'schedule'='manual',scheduledAt?:number){const task=this.task(id);const workflow=task.workflowId?this.workflow(task.workflowId,task.cwd):undefined;return this.launch({task,workflow,cwd:task.cwd,args:task.args,permission:task.permission,model:task.model,thinking:task.thinking,trigger,scheduledAt,sessionMode:task.sessionMode});}
 runWorkflow(input:WorkflowLaunch){const cwd=directory(input.cwd);return this.launch({...input,cwd,workflow:this.workflow(input.id,cwd),trigger:'manual'});}
 private launch(input:{task?:AutomationTask;workflow?:SavedWorkflow;cwd:string;args:Record<string,string>;permission:WorkflowLaunch['permission'];model?:string;thinking?:WorkflowLaunch['thinking'];trigger:'manual'|'schedule';scheduledAt?:number;sessionMode?:'reuse'|'fresh'}){
  if(this.closed)throw Error('自动化服务正在关闭');if(!isAccessMode(input.permission))throw Error('访问模式无效');if(input.thinking&&!THINKING_LEVELS.includes(input.thinking))throw Error('思考等级无效');
  if(this.data.runs.some(r=>live(r)&&(input.task?r.taskId===input.task.id:r.workflowId===input.workflow?.id&&r.cwd===input.cwd)))throw Error('已有运行正在执行，不能重复启动');
  if(this.data.runs.filter(live).length>=3)throw Error('最多同时运行 3 个自动化，请稍后再试');
  const prompts=input.workflow?workflowPrompts(input.workflow,input.args):[input.task!.prompt];
  const run:AutomationRun={id:randomUUID(),taskId:input.task?.id,workflowId:input.workflow?.id,name:input.task?.name||input.workflow!.name,cwd:input.cwd,trigger:input.trigger,status:'running',startedAt:this.now(),scheduledAt:input.scheduledAt,stepIndex:0,steps:prompts.map((_,i)=>({name:input.workflow?.steps[i].name||input.task!.name,status:'pending'}))};
  this.data.runs.unshift(run);this.data.runs=this.data.runs.filter((r,i)=>i<500||live(r));
  if(input.task){input.task.runCount++;input.task.lastRunAt=this.now();if(input.task.maxRuns&&input.task.runCount>=input.task.maxRuns)input.task.enabled=false;}
  this.persist();void this.execute(run,prompts,input);return structuredClone(run);
 }
 /** 解析执行会话：默认复用项目下最近活跃的会话，让任务跑在用户正在对话的上下文里
  *  （此前每次自动化都新起独立会话，任务结论散落在侧栏各处）；fresh 才强制新会话。
  *  复用必须是 **idle** 会话：步骤完成归因依赖「prompt 后下一个 agent_settled 属于本步骤」，
  *  复用 busy 会话时用户任务的 settle 会抢在前头，步骤状态整体错位。同 cwd 已有自动化
  *  在跑时也不再复用（不同 run 共享 key 会互相覆盖 waiter），直接新会话隔离。 */
 private async resolveSession(cwd:string,sessionMode:'reuse'|'fresh'|undefined,config:{permission:WorkflowLaunch['permission'];model?:string},self?:AutomationRun):Promise<{key:string;reused:boolean}>{
  const backend=this.backend();
  if(sessionMode==='fresh'||this.data.runs.some(r=>live(r)&&r!==self&&r.cwd===cwd)){
   const session=await backend.connect({cwd,trustProject:false,permission:config.permission,model:config.model});
   return {key:session.key,reused:false};
  }
  // macOS /var→/private/var：会话文件 header 的 cwd 未必 realpath 过，归一化后比较
  const target=canonical(cwd);
  const sameCwd=(v:string)=>{try{return canonical(v)===target;}catch{return v===cwd;}};
  // 只复用 idle 且无排队/无待审批的会话（starting/stopping/waiting/error 一律不复用）
  const idleRun=backend.runs().filter(r=>r.status==='idle'&&!r.pending&&!r.queue?.length&&sameCwd(r.cwd))
    .sort((a,b)=>(b.timing?.endedAt??b.timing?.startedAt??0)-(a.timing?.endedAt??a.timing?.startedAt??0))[0];
  if(idleRun&&!backend.hasPendingDialogs(idleRun.key))return {key:idleRun.key,reused:true};
  // 会话文件复用仅限 Desktop 自建（owned）：外部 CLI 文件 connect 会 fork parentSession 副本，
  // 产出不在用户原会话里，与「上下文连续」相悖。超限/损坏（#78）回落新建。
  const recent=this.index().scan().filter(s=>s.owned&&!s.parentSession&&sameCwd(s.cwd)).sort((a,b)=>b.updatedAt-a.updatedAt)[0];
  if(recent){
   try{const session=await backend.connect({sourceKey:recent.key,cwd,trustProject:false,permission:config.permission});return {key:session.key,reused:true};}
   catch{ /* 超限/损坏：回落新建 */ }
  }
  const session=await backend.connect({cwd,trustProject:false,permission:config.permission,model:config.model});
  return {key:session.key,reused:false};
 }
 private async execute(run:AutomationRun,prompts:string[],config:{permission:WorkflowLaunch['permission'];model?:string;thinking?:WorkflowLaunch['thinking'];sessionMode?:'reuse'|'fresh'}){
  let key:string|undefined;let reused=false;
  try{
   const backend=this.backend();const resolved=await this.resolveSession(run.cwd,config.sessionMode,config,run);key=resolved.key;reused=resolved.reused;run.sessionKey=key;run.reusedSession=reused;
   if(!live(run)||this.closed){if(!reused)backend.close(key);return;}
   // 复用会话沿用该会话当前的模型/思考等级（不能永久改写用户的会话级设置）；fresh 才应用任务配置
   if(config.thinking&&!reused)await backend.thinking(key,config.thinking);
   for(let i=0;i<prompts.length;i++){
    if(!live(run)||this.closed)break;run.stepIndex=i;run.steps[i].status='running';this.persist();
    let resolve!:()=>void,reject!:(e:Error)=>void;
    const settled=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});settled.catch(()=>{});
    this.stepErrors.delete(key);this.waiters.set(key,{resolve,reject});
    try {await backend.prompt(key,automationPromptText(run.name,run.steps[i].name,i+1,prompts.length,prompts[i]),'followUp');await settled;}finally{this.waiters.delete(key);this.stepErrors.delete(key);}
    if(!live(run))break;run.steps[i].status='succeeded';
   }
   if(live(run))run.status='succeeded';
  }catch(error){if(live(run)){run.status='failed';run.error=String((error as Error).message||error);if(run.steps[run.stepIndex])run.steps[run.stepIndex].status='failed';}}
  finally{run.endedAt=this.now();for(const step of run.steps)if(step.status==='running')step.status=run.status==='failed'?'failed':'stopped';this.persist();if(key){this.waiters.delete(key);if(!reused)this.backend().close(key);}}
 }
 onPiEvent(event:PiEvent){
  const key=event.type==='run'?event.run.key:'key' in event?event.key:undefined;if(!key)return;
  const run=this.data.runs.find(r=>r.sessionKey===key&&(live(r)||r.status==='stopped'));if(!run)return;
  if(event.type==='run'&&event.run.status==='stopping'&&live(run)){run.status='stopped';run.endedAt=this.now();this.persist();}
  if(run.status==='stopped'){if(event.type==='rpc'&&event.event.type==='agent_settled')setTimeout(()=>this.waiters.get(key)?.reject(Error('用户停止')),0);return;}
  if(event.type==='ui'&&['confirm','input','select','editor'].includes(event.request.method)){run.status='waiting';this.persist();}
  if(event.type==='rpc'){
   if(event.event.type==='tool_execution_start'&&run.status==='waiting'){run.status='running';this.persist();}
   const m=event.event.message as any;
   if(event.event.type==='message_end'&&m?.role==='assistant'){
    if(['error','aborted'].includes(m.stopReason))this.stepErrors.set(key,m.errorMessage||'模型执行失败或已停止');
    else this.stepErrors.delete(key);
   }
   if(event.event.type==='agent_settled'){const error=this.stepErrors.get(key);if(error)this.waiters.get(key)?.reject(Error(error));else this.waiters.get(key)?.resolve();}
  }
  if(event.type==='closed'||event.type==='run'&&event.run.status==='error')this.waiters.get(key)?.reject(Error('pi 运行进程已退出'));
 }
 async stop(id:string){const run=this.data.runs.find(r=>r.id===id);if(!run||!live(run))return;run.status='stopped';run.endedAt=this.now();this.persist();
  // 复用的会话是用户自己的：不 abort（会连用户正在跑的任务一起杀），只解除监护——
  // 当前步骤若已在用户会话里执行会自然跑完，剩余步骤因 !live 不再分发。
  if(run.sessionKey&&!run.reusedSession){try{await this.backend().stop(run.sessionKey);}finally{this.waiters.get(run.sessionKey)?.reject(Error('用户停止'));}return;}
  if(run.sessionKey)this.waiters.get(run.sessionKey)?.reject(Error('用户停止'));}
 tick(){if(this.closed)return;const now=this.now();for(const task of this.data.tasks){if(!task.enabled||!task.nextRunAt||task.nextRunAt>now)continue;const due=task.nextRunAt;
   task.nextRunAt=task.schedule.kind==='interval'?due+(Math.floor((now-due)/(task.schedule.minutes*60000))+1)*task.schedule.minutes*60000:nextSchedule(task.schedule,now);if(!task.nextRunAt||task.endAt&&task.nextRunAt>task.endAt)task.enabled=false;
   if(task.endAt&&due>task.endAt||task.maxRuns&&task.runCount>=task.maxRuns){task.enabled=false;this.persist();continue;}
   this.persist();
   try{if(now-due>60000)throw Error('客户端未及时运行，已跳过错过的触发时间');this.runTask(task.id,'schedule',due);}catch(error){this.data.runs.unshift({id:randomUUID(),taskId:task.id,workflowId:task.workflowId,name:task.name,cwd:task.cwd,trigger:'schedule',status:'skipped',startedAt:now,endedAt:now,scheduledAt:due,error:String((error as Error).message||error),stepIndex:0,steps:[]});this.data.runs=this.data.runs.filter((r,i)=>i<500||live(r));this.persist();}
  }}
 dispose(){this.closed=true;clearInterval(this.timer);for(const run of this.data.runs)if(live(run)){run.status='interrupted';run.endedAt=this.now();run.error='客户端退出，任务未自动重放';for(const step of run.steps)if(step.status==='running')step.status='stopped';if(run.sessionKey)this.waiters.get(run.sessionKey)?.reject(Error(run.error));}this.persist();}
}
