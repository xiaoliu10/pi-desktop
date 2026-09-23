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
it('registers a metadata-only tool with validated round-trip progress results',async()=>{let tool:any;registerDesktopPlan({registerTool:(t:any)=>tool=t});const args={plan:[{step:' Test ',status:'in_progress'}]};const result=await tool.execute('id',args);expect(JSON.parse(result.content[0].text)).toEqual({plan:[{step:'Test',status:'in_progress'}]});await expect(tool.execute('id',{plan:[{step:'',status:'completed'}]})).rejects.toThrow();});
