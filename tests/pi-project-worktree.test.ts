import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';
import {afterEach,expect,it} from 'vitest';
import {createProjectWorktree} from '../src/main/pi/project-worktree';
const roots:string[]=[];afterEach(async()=>{await Promise.all(roots.splice(0).map(p=>fs.rm(p,{recursive:true,force:true})));});
async function setup(){const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'pi-worktree-')));roots.push(root);const project=path.join(root,'repo');await fs.mkdir(project);execFileSync('git',['init','-q',project]);await fs.writeFile(path.join(project,'file.txt'),'committed');execFileSync('git',['-C',project,'add','.']);execFileSync('git',['-C',project,'-c','user.name=Desktop Test','-c','user.email=test@example.invalid','-c','core.hooksPath=/dev/null','commit','-qm','initial']);return{root,project};}
it('creates a permanent worktree on a new branch without moving uncommitted changes',async()=>{
 const{root,project}=await setup();await fs.writeFile(path.join(project,'file.txt'),'uncommitted');
 const result=await createProjectWorktree({projectPath:project,parentDirectory:root,folder:'isolated',branch:'codex/test-worktree'});
 expect(await fs.readFile(path.join(result.path,'file.txt'),'utf8')).toBe('committed');expect(await fs.readFile(path.join(project,'file.txt'),'utf8')).toBe('uncommitted');
 expect(execFileSync('git',['-C',result.path,'branch','--show-current'],{encoding:'utf8'}).trim()).toBe('codex/test-worktree');
 expect(execFileSync('git',['-C',project,'worktree','list'],{encoding:'utf8'})).toContain(result.path);
});
it('rejects path traversal and existing directories without overwriting files',async()=>{
 const{root,project}=await setup();const input={projectPath:project,parentDirectory:root,folder:'repo',branch:'codex/test'};
 await expect(createProjectWorktree(input)).rejects.toThrow('已存在');await expect(createProjectWorktree({...input,folder:'../outside'})).rejects.toThrow('有效');
 expect(await fs.readFile(path.join(project,'file.txt'),'utf8')).toBe('committed');
});
