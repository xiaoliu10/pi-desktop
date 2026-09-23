import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import { afterEach, expect, it } from 'vitest';import { resourceCatalog } from '../src/main/pi/resource-catalog';
const roots:string[]=[];afterEach(()=>roots.splice(0).forEach(p=>fs.rmSync(p,{recursive:true,force:true})));
it('catalogs global, project and npm resources without evaluating code; separates runtime evidence',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-resources-'));roots.push(root);const agent=path.join(root,'agent'),project=path.join(root,'project');
 fs.mkdirSync(path.join(agent,'extensions'),{recursive:true});fs.mkdirSync(path.join(project,'.pi/skills/demo'),{recursive:true});
 const ext=path.join(agent,'extensions/test.ts');fs.writeFileSync(ext,'throw new Error("MUST NOT EXECUTE")');
 const pkg=path.join(agent,'npm/node_modules/example');fs.mkdirSync(path.join(pkg,'extensions'),{recursive:true});fs.writeFileSync(path.join(pkg,'extensions/tool.ts'),'throw 1');
 fs.writeFileSync(path.join(pkg,'package.json'),JSON.stringify({pi:{extensions:['extensions/*.ts']}}));
 fs.writeFileSync(path.join(agent,'settings.json'),JSON.stringify({packages:['npm:example@1.0'],extensions:['!extensions/test.ts','missing.ts']}));
 const all=resourceCatalog(agent,project,[],path.join(root,'shared-skills'));
 expect(all.find(r=>r.path===ext)?.status).toBe('disabled');expect(all.find(r=>r.name==='missing.ts')?.status).toBe('missing');expect(all.find(r=>r.name==='tool.ts')?.status).toBe('discovered');expect(all.some(r=>r.scope==='project')).toBe(true);
 const runtime=resourceCatalog(agent,project,[{name:'loaded',path:path.join(pkg,'extensions/tool.ts')}],path.join(root,'shared-skills'));expect(runtime.find(r=>r.name==='tool.ts')?.status).toBe('callable');
});
