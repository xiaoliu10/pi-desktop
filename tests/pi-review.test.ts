import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import { execFileSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';import { workspaceReview } from '../src/main/pi/workspace-review';
const roots:string[]=[];afterEach(()=>roots.splice(0).forEach(p=>fs.rmSync(p,{recursive:true,force:true})));
it('reports cumulative tracked changes and shell-created untracked files without altering them',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-review-'));roots.push(root);const git=(...args:string[])=>execFileSync('git',args,{cwd:root,stdio:'pipe'});
 git('init');fs.writeFileSync(path.join(root,'a.txt'),'one\ntwo\n');git('add','.');git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','base');
 fs.writeFileSync(path.join(root,'a.txt'),'ONE\nTWO\n');fs.writeFileSync(path.join(root,'new.txt'),'shell output');
 const review=await workspaceReview(root);expect(review.diff).toContain('+ONE');expect(review.diff).toContain('+TWO');expect(review.untracked).toContain('new.txt');
 expect(review.untrackedFiles).toContainEqual({path:'new.txt',lines:1});
 fs.writeFileSync(path.join(root,'b.md'),'1\n2\n3\n');const multi=(await workspaceReview(root)).untrackedFiles??[];expect(multi).toContainEqual({path:'b.md',lines:3});
 fs.writeFileSync(path.join(root,'a.txt'),'one\ntwo\n');expect((await workspaceReview(root)).diff).toBe('');
});
