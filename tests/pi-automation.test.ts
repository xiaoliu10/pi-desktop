import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import { AutomationService, nextSchedule, validateWorkflow } from '../src/main/pi/automation-service';
import { workflowPrompts } from '../src/shared/automation';
import type { AutomationTask, SavedWorkflow } from '../src/shared/automation';
import type { PiBackend } from '../src/main/pi/backend';
import type { SessionIndex } from '../src/main/pi/session-index';
const roots:string[]=[];const services:AutomationService[]=[];
afterEach(()=>{services.splice(0).forEach(s=>s.dispose());roots.splice(0).forEach(r=>fs.rmSync(r,{recursive:true,force:true}));});
function setup(indexOverride?:unknown){const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-auto-'));roots.push(root);let now=Date.parse('2026-09-21T00:00:00Z');let seq=0;let service:AutomationService;
 const backend={connect:vi.fn(async()=>({key:`run-${++seq}`})),thinking:vi.fn(async()=>{}),prompt:vi.fn(async()=>{}),close:vi.fn(),stop:vi.fn(async()=>{}),runs:()=>[]};
 const index=(indexOverride??{scan:()=>[]}) as unknown as SessionIndex;
 service=new AutomationService(path.join(root,'automation.json'),()=>backend as unknown as PiBackend,()=>index,()=>{},()=>now);services.push(service);
 const task=(overrides:Partial<AutomationTask>={})=>service.saveTask({id:'',name:'Daily check',cwd:root,prompt:'Check only',args:{},permission:'plan',schedule:{kind:'interval',minutes:1},enabled:true,runCount:0,updatedAt:0,...overrides});
 const workflow=(overrides:Partial<SavedWorkflow>={})=>service.saveWorkflow({id:'',name:'Review',description:'Review changes',whenToUse:'Before commit',scope:'project',cwd:root,parameters:[{name:'target',type:'string',required:true,description:'Target'}],steps:[{id:'1',name:'Inspect',prompt:'Inspect {{target}}'},{id:'2',name:'Summarize',prompt:'Summarize findings'}],updatedAt:0,...overrides});
 const settle=(key:string)=>service.onPiEvent({type:'rpc',key,generation:'g',event:{type:'agent_settled'}});
 return {root,service,backend,task,workflow,settle,now:()=>now,advance:(ms:number)=>{now+=ms;}};
}
it('validates dates, intervals, five-field cron and computes the next future occurrence',()=>{
 const now=Date.parse('2026-09-21T00:00:00Z');expect(nextSchedule({kind:'interval',minutes:5},now)).toBe(now+300000);
 expect(nextSchedule({kind:'once',at:now-1},now)).toBeUndefined();expect(()=>nextSchedule({kind:'interval',minutes:0},now)).toThrow();
 expect(nextSchedule({kind:'cron',expression:'*/15 * * * *'},now)).toBe(now+900000);expect(()=>nextSchedule({kind:'cron',expression:'bad'},now)).toThrow();
});
it('validates typed workflow arguments and undefined references without executing code',()=>{
 const h=setup(),w=h.workflow();expect(workflowPrompts(w,{target:'src/'})).toEqual(['Inspect src/','Summarize findings']);
 expect(()=>workflowPrompts(w,{})).toThrow('target');expect(()=>validateWorkflow({...w,steps:[{id:'x',name:'X',prompt:'{{missing}}'}]})).toThrow('未声明');
 const numbers={...w,parameters:[{name:'target',type:'number' as const,description:'',required:true}]};expect(()=>workflowPrompts(numbers,{target:'oops'})).toThrow('数字');
});
it('runs workflow steps sequentially in one isolated pi session and persists outcome',async()=>{
 const h=setup(),w=h.workflow();const run=h.service.runWorkflow({id:w.id,cwd:h.root,args:{target:'README'},permission:'ask'});
 await vi.waitFor(()=>expect(h.backend.prompt).toHaveBeenCalledTimes(1));expect(h.backend.connect).toHaveBeenCalledWith(expect.objectContaining({permission:'ask',trustProject:false}));
 expect(h.backend.prompt.mock.calls[0][1]).toContain('Inspect README');h.settle('run-1');
 await vi.waitFor(()=>expect(h.backend.prompt).toHaveBeenCalledTimes(2));expect(h.backend.prompt.mock.calls[1][0]).toBe('run-1');h.settle('run-1');
 await vi.waitFor(()=>expect(h.service.snapshot().runs[0].status).toBe('succeeded'));
 expect(h.service.snapshot().runs[0].steps.map(s=>s.status)).toEqual(['succeeded','succeeded']);expect(h.backend.close).toHaveBeenCalledWith('run-1');
 expect(JSON.parse(fs.readFileSync(path.join(h.root,'automation.json'),'utf8')).runs[0].id).toBe(run.id);
});
it('reuse mode (default): prefers a live session, then the most recent project session, and never closes it',async()=>{
 // 1) live run 复用：backend.runs 返回同 cwd 的 idle 会话 → connect 不被调用、结束不 close
 const h=setup();
 const runsSpy = vi.fn(() => [{ key: 'live-1', cwd: h.root, status: 'idle', timing: { startedAt: 1 } }]);
 (h.backend as unknown as { runs: unknown }).runs = runsSpy;
 const w1=h.workflow();h.service.runWorkflow({id:w1.id,cwd:h.root,args:{target:'X'},permission:'ask'});
 await vi.waitFor(()=>expect(h.backend.prompt).toHaveBeenCalledTimes(1));h.settle('live-1');
 await vi.waitFor(()=>expect(h.backend.prompt).toHaveBeenCalledTimes(2));h.settle('live-1');
 await vi.waitFor(()=>expect(h.service.snapshot().runs[0].status).toBe('succeeded'));
 expect(h.backend.connect).not.toHaveBeenCalled();
 expect(h.service.snapshot().runs[0].sessionKey).toBe('live-1');
 expect(h.service.snapshot().runs[0].reusedSession).toBe(true);
 expect(h.backend.close).not.toHaveBeenCalledWith('live-1');

 // 2) 无 live run：按 updatedAt 取最近的会话文件走 sourceKey 连接
 const files:string[]=[];for(let i=0;i<2;i++){const f=path.join(h.root,`s${i}.jsonl`);fs.writeFileSync(f,JSON.stringify({type:'session',version:3,id:`s${i}`,cwd:h.root,timestamp:new Date().toISOString()})+'\n');files.push(f);}
 fs.utimesSync(files[0],new Date(Date.now()-60000),new Date(Date.now()-60000)); // 更旧
 const h2=setup({ scan: () => files.map((f,i) => ({ key: `k${i}`, path: f, cwd: h2.root, updatedAt: Date.now()-i*1000, name: `s${i}`, size: 10, parentSession: undefined, owned: false })) });
 const w2=h2.workflow();h2.service.runWorkflow({id:w2.id,cwd:h2.root,args:{target:'Y'},permission:'ask'});
 await vi.waitFor(()=>expect(h2.backend.prompt).toHaveBeenCalledTimes(1));h2.settle('run-1');
 await vi.waitFor(()=>expect(h2.backend.prompt).toHaveBeenCalledTimes(2));h2.settle('run-1');
 await vi.waitFor(()=>expect(h2.service.snapshot().runs[0].status).toBe('succeeded'));
 expect(h2.backend.connect).toHaveBeenCalledWith(expect.objectContaining({sourceKey:'k0'})); // 最近更新的文件
 expect(h2.backend.close).not.toHaveBeenCalled(); // 复用的会话不 close

 // 3) fresh：明确要求独立会话 → 新 connect + 运行结束 close
 const h3=setup();const w3=h3.workflow();
 h3.service.runWorkflow({id:w3.id,cwd:h3.root,args:{target:'Z'},permission:'ask'});
 await vi.waitFor(()=>expect(h3.backend.prompt).toHaveBeenCalledTimes(1));h3.settle('run-1');
 await vi.waitFor(()=>expect(h3.backend.prompt).toHaveBeenCalledTimes(2));h3.settle('run-1');
 await vi.waitFor(()=>expect(h3.service.snapshot().runs[0].status).toBe('succeeded'));
 // directory() 会 realpath cwd（macOS /var→/private/var），断言用 canonical 比较
 const c=(v:string)=>fs.realpathSync(v);
 expect(h3.backend.connect).toHaveBeenCalledWith(expect.objectContaining({cwd:c(h3.root),trustProject:false}));
 expect(h3.backend.close).toHaveBeenCalledWith('run-1'); // 自己新建的会话照旧回收
});

it('claims scheduled occurrences once, blocks overlap, and retains phase-aligned interval times',async()=>{
 const h=setup(),task=h.task();h.advance(61000);h.service.tick();h.service.tick();await vi.waitFor(()=>expect(h.backend.prompt).toHaveBeenCalledTimes(1));
 expect(h.service.snapshot().tasks[0].nextRunAt).toBe(Date.parse('2026-09-21T00:02:00Z'));
 expect(()=>h.service.runTask(task.id)).toThrow('已有运行');h.advance(60000);h.service.tick();expect(h.service.snapshot().runs[0].status).toBe('skipped');
 h.settle('run-1');await vi.waitFor(()=>expect(h.service.snapshot().runs.find(r=>r.sessionKey==='run-1')?.status).toBe('succeeded'));
});
it('skips missed one-shot runs and does not replay them after restart',()=>{
 const h=setup();h.task({schedule:{kind:'once',at:h.now()+60000}});h.advance(180000);h.service.tick();expect(h.service.snapshot().runs[0].status).toBe('skipped');expect(h.service.snapshot().tasks[0].enabled).toBe(false);h.service.tick();expect(h.service.snapshot().runs).toHaveLength(1);
 const next=new AutomationService(path.join(h.root,'automation.json'),()=>h.backend as unknown as PiBackend,()=>{},h.now);services.push(next);next.tick();expect(next.snapshot().runs).toHaveLength(1);
});
it('pauses schedules, enforces run limits and does not delete running definitions',async()=>{
 const h=setup(),task=h.task({maxRuns:1});h.service.toggle(task.id);h.advance(120000);h.service.tick();expect(h.backend.connect).not.toHaveBeenCalled();h.service.toggle(task.id);h.advance(60000);h.service.tick();await vi.waitFor(()=>expect(h.backend.prompt).toHaveBeenCalledTimes(1));expect(h.service.snapshot().tasks[0].enabled).toBe(false);
 expect(()=>h.service.deleteTask(task.id)).toThrow('先停止');expect(()=>h.service.toggle(task.id)).toThrow('上限');h.settle('run-1');
});
it('stops an approval-waiting workflow without dispatching the next step',async()=>{
 const h=setup(),w=h.workflow();const run=h.service.runWorkflow({id:w.id,cwd:h.root,args:{target:'src'},permission:'ask'});
 await vi.waitFor(()=>expect(h.backend.prompt).toHaveBeenCalledTimes(1));h.service.onPiEvent({type:'ui',key:'run-1',generation:'g',request:{id:'approve',method:'confirm'}});expect(h.service.snapshot().runs[0].status).toBe('waiting');
 await h.service.stop(run.id);await vi.waitFor(()=>expect(h.backend.close).toHaveBeenCalledWith('run-1'));expect(h.service.snapshot().runs[0].status).toBe('stopped');expect(h.backend.prompt).toHaveBeenCalledTimes(1);
});
it('records startup failure and marks crashed runs interrupted without replay',async()=>{
 const h=setup(),task=h.task();h.backend.connect.mockRejectedValueOnce(Error('missing pi'));h.service.runTask(task.id);await vi.waitFor(()=>expect(h.service.snapshot().runs[0].status).toBe('failed'));
 h.service.runTask(task.id);await vi.waitFor(()=>expect(h.backend.prompt).toHaveBeenCalledTimes(1));const snapshot=h.service.snapshot();
 const file=path.join(h.root,'crash.json');fs.writeFileSync(file,JSON.stringify(snapshot));const recovered=new AutomationService(file,()=>h.backend as unknown as PiBackend);services.push(recovered);expect(recovered.snapshot().runs[0].status).toBe('interrupted');
});
it('protects project-scoped workflows and references, supports global promotion',()=>{
 const h=setup(),w=h.workflow();h.task({workflowId:w.id,prompt:'',args:{target:'src'}});expect(()=>h.service.deleteWorkflow(w.id)).toThrow('引用');
 const other=fs.mkdtempSync(path.join(os.tmpdir(),'pi-auto-other-'));roots.push(other);expect(()=>h.service.runWorkflow({id:w.id,cwd:other,args:{target:'src'},permission:'plan'})).toThrow('所属项目');
 h.service.saveWorkflow({...w,scope:'global'});expect(h.service.snapshot().workflows[0].cwd).toBe('');
});

it('waits through native model retries and fails only when pi settles with an error',async()=>{
 const h=setup(),w=h.workflow();h.service.runWorkflow({id:w.id,cwd:h.root,args:{target:'src'},permission:'plan'});
 await vi.waitFor(()=>expect(h.backend.prompt).toHaveBeenCalledTimes(1));
 h.service.onPiEvent({type:'rpc',key:'run-1',generation:'g',event:{type:'message_end',message:{role:'assistant',stopReason:'error',errorMessage:'temporary'}}});
 expect(h.service.snapshot().runs[0].status).toBe('running');
 h.service.onPiEvent({type:'rpc',key:'run-1',generation:'g',event:{type:'message_end',message:{role:'assistant',stopReason:'stop'}}});h.settle('run-1');
 await vi.waitFor(()=>expect(h.backend.prompt).toHaveBeenCalledTimes(2));
 h.service.onPiEvent({type:'rpc',key:'run-1',generation:'g',event:{type:'message_end',message:{role:'assistant',stopReason:'error',errorMessage:'final failure'}}});h.settle('run-1');
 await vi.waitFor(()=>expect(h.service.snapshot().runs[0].status).toBe('failed'));expect(h.service.snapshot().runs[0].error).toBe('final failure');
});
