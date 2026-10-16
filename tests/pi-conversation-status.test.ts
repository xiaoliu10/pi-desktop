import { describe,it,expect,afterEach } from 'vitest';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {gitStatus} from '../src/main/pi/git-status';
import {conversationPlan} from '../src/renderer/pi/conversation-plan';
import type {ChatMessage} from '../src/renderer/replica/contracts';
// @ts-expect-error Pi runtime extension is native JavaScript.
import {registerDesktopPlan} from '../extensions/desktop-policy/plan.mjs';
const dirs:string[]=[];
afterEach(async()=>{await Promise.all(dirs.splice(0).map(d=>rm(d,{recursive:true,force:true})));});
async function repo(){const cwd=await mkdtemp(path.join(os.tmpdir(),'pi-status-'));dirs.push(cwd); const git=(...args:string[])=>execFileSync('git',args,{cwd,encoding:'utf8'});git('init','-b','main');git('config','user.email','test@example.invalid');git('config','user.name','Test');return {cwd,git};}
describe('Git status',()=>{
 it('handles unborn HEAD and excludes untracked lines from diff totals',async()=>{const {cwd,git}=await repo();await writeFile(path.join(cwd,'new.txt'),'one\ntwo\n');git('add','new.txt');await writeFile(path.join(cwd,'other.txt'),'untracked\n');const s=await gitStatus(cwd);expect(s).toMatchObject({repository:true,branch:'main',added:2,removed:0,changed:1,untracked:1});});
 it('counts net tracked changes, rename paths, binary files and branches',async()=>{const {cwd,git}=await repo();await writeFile(path.join(cwd,'old.txt'),'first\nsecond\n');await writeFile(path.join(cwd,'binary'),'\0one');git('add','.');git('commit','-m','initial');git('branch','feature');git('mv','old.txt','renamed\nfile.txt');await writeFile(path.join(cwd,'renamed\nfile.txt'),'first\nchanged\nthird\n');await writeFile(path.join(cwd,'binary'),'\0two');const s=await gitStatus(cwd);expect(s.added-s.removed).toBe(1);expect(s.changed).toBeGreaterThanOrEqual(2);expect(s.binary).toBe(1);expect(s.branches).toEqual(['feature','main']);});
 it('returns a non-repository state without invented branch',async()=>{const {cwd}=await repo();const outside=await mkdtemp(path.join(os.tmpdir(),'pi-notgit-'));dirs.push(outside);expect(await gitStatus(outside)).toMatchObject({repository:false,branch:''});});
});
const msg=(plan:unknown,status:'done'|'error'|'running'='done',phase:'result'|'progress'|'call'='result',id='one'):ChatMessage=>({id,role:'assistant',parts:[{kind:'tool',id,callId:id,tool:'desktop_update_plan',status,phase,detailLines:[JSON.stringify({plan})]}]});
it('uses successful plans, ignores failures and incomplete updates, restores historical state',()=>{const pending=[{step:'Build',status:'pending'}],done=[{step:'Build',status:'completed'}];expect(conversationPlan([msg(pending),msg(done,'error')])).toEqual(pending);expect(conversationPlan([msg(pending),msg(done,'done','progress','two')])).toEqual(done);expect(conversationPlan([msg(done),msg(pending,'done','progress')])).toEqual(done);expect(conversationPlan([msg(pending),msg([{step:'Bad',status:'fake'}])])).toEqual(pending);expect(conversationPlan([msg(done),msg([])])).toEqual([]);});
<<<<<<< Updated upstream
=======
const userMsg=(id:string,text='go'):ChatMessage=>({id,role:'user',parts:[{kind:'text',text}]});
// 跨任务长会话：上一轮的旧 plan 不得继续占位（真实事故：一个从 09-29 用到现在的会话
// 有 375 条 plan 记录，面板一直显示最早那批 LiteLLM 相关清单）。
it('scopes the checklist to the latest turn, dropping plans from earlier tasks',()=>{
 const old=[{step:'核对 LiteLLM 原生清理调度、保留配置及 PostgreSQL 维护约束',status:'completed'},{step:'设计半年保留、零点后原生调度与按需 FULL 的最小改造方案',status:'completed'}];
 const current=[{step:'修复计划面板显示旧内容',status:'in_progress'},{step:'补回归测试',status:'pending'}];
 const history=[userMsg('u1'),msg(old,'done','result','old-a'),msg(old.map((s,i)=>({...s,status:'completed'})),'done','result','old-b'),userMsg('u2','帮我看看别的'),userMsg('u3','接着修')];
 // u3 之后还没有新 plan：面板应为空，而不是复活 u1 那轮的旧清单
 expect(conversationPlan(history)).toEqual([]);
 // 新一轮产出 plan 后，只显示这一轮的
 expect(conversationPlan([...history,msg(current)])).toEqual(current);
 // 旧 plan 在前、新 plan 在后的完整跨任务序列同样只取最新一轮
 expect(conversationPlan([userMsg('u0'),msg(old),userMsg('u1'),msg(current)])).toEqual(current);
});
it('keeps a turn whose plan arrives before any user message (pure tool continuation)',()=>{
 // 无用户消息的纯工具续跑：整段都是同一轮，早前的 plan 与续跑产出的 plan 都该被扫到，
 // 收敛到最后一次成功结果（而不是只认最后一条消息——那会漏掉续跑前的历史 plan）。
 const old=[{step:'Earlier task',status:'completed'}],fresh=[{step:'Resumed work',status:'in_progress'}];
 expect(conversationPlan([msg(old),msg(fresh,'done','result','two')])).toEqual(fresh);
 expect(conversationPlan([msg(fresh)])).toEqual(fresh);
});
// 上一条只断言同轮收敛，容易被「无边界实现的扫全量」蒙混；这条构造泄漏场景：
// 旧 plan 是最后一次成功结果且当前轮没有 plan —— 只有按轮次扫描才会返回空。
it('returns empty when the newest turn has no plan, even if an earlier turn does',()=>{
 const old=[{step:'Old task',status:'completed'}];
 expect(conversationPlan([userMsg('u1'),msg(old),userMsg('u2')])).toEqual([]);
 // 当前轮只进度、未出结果：采纳本轮 progress（原契约：progress 在没有对应 result 时就是数据源），
 // 但绝不是上一轮的 plan
 expect(conversationPlan([userMsg('u1'),msg(old),userMsg('u2'),msg([{step:'New',status:'pending'}],'done','progress')])).toEqual([{step:'New',status:'pending'}]);
 // 空文本用户消息仍是轮次边界（真实会话有空提交/注入标记）
 expect(conversationPlan([userMsg('u1'),msg(old),userMsg('u2','')])).toEqual([]);
});
it('takes the last successful plan within the current turn only',()=>{const a=[{step:'One',status:'pending'}],b=[{step:'Two',status:'completed'}];expect(conversationPlan([userMsg('u1'),msg(a),msg(b,'done','result','two')])).toEqual(b);expect(conversationPlan([userMsg('u1'),msg(a),userMsg('u2'),msg(b)])).toEqual(b);});
>>>>>>> Stashed changes
it('registers a metadata-only tool with validated round-trip progress results',async()=>{let tool:any;registerDesktopPlan({registerTool:(t:any)=>tool=t});const args={plan:[{step:' Test ',status:'in_progress'}]};const result=await tool.execute('id',args);expect(JSON.parse(result.content[0].text)).toEqual({plan:[{step:'Test',status:'in_progress'}]});await expect(tool.execute('id',{plan:[{step:'',status:'completed'}]})).rejects.toThrow();});
