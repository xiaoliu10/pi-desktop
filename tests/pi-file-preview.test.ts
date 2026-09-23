import {it,expect,afterEach} from 'vitest';
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';
import {filePreview} from '../src/main/pi/file-preview';
import {parseUnifiedDiff} from '../src/renderer/pi/adapter';
const dirs:string[]=[];afterEach(async()=>{await Promise.all(dirs.splice(0).map(d=>fs.rm(d,{recursive:true,force:true})));});
async function setup(){const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'pi-file-preview-'));dirs.push(cwd);const git=(...args:string[])=>execFileSync('git',args,{cwd});git('init','-b','main');git('config','user.name','Test');git('config','user.email','test@example.invalid');await fs.writeFile(path.join(cwd,'a[1].ts'),'old\n');await fs.writeFile(path.join(cwd,'a1.ts'),'other\n');git('add','.');git('commit','-m','initial');return {cwd,git};}
it('loads only the clicked file and its net staged/unstaged diff with literal paths',async()=>{
 const {cwd,git}=await setup();await fs.writeFile(path.join(cwd,'a[1].ts'),'staged\n');git('add','.');await fs.writeFile(path.join(cwd,'a[1].ts'),'new\n');await fs.writeFile(path.join(cwd,'a1.ts'),'unrelated\n');
 const result=await filePreview(cwd,'a[1].ts');expect(result.content).toBe('new\n');expect(result.diff).toContain('-old');expect(result.diff).toContain('+new');expect(result.diff).not.toContain('unrelated');expect(parseUnifiedDiff(result.diff)).toHaveLength(1);
});
it('shows clean and untracked text without inventing a baseline',async()=>{
 const {cwd}=await setup();expect(await filePreview(cwd,path.join(cwd,'a1.ts'))).toMatchObject({content:'other\n',diff:''});await fs.writeFile(path.join(cwd,'new.txt'),'untracked');expect(await filePreview(cwd,'new.txt')).toMatchObject({content:'untracked',diff:''});
});
it('supports deleted files and reports missing or binary contents',async()=>{
 const {cwd}=await setup();await fs.unlink(path.join(cwd,'a1.ts'));const deleted=await filePreview(cwd,'a1.ts');expect(deleted.content).toBeUndefined();expect(parseUnifiedDiff(deleted.diff)[0]).toMatchObject({path:'a1.ts',deletions:1});
 expect((await filePreview(cwd,'missing.txt')).note).toContain('不存在');await fs.writeFile(path.join(cwd,'binary'),Buffer.from([0,1,2]));expect((await filePreview(cwd,'binary')).note).toContain('二进制');
});
