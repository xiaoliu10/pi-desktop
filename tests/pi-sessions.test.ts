import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionIndex } from '../src/main/pi/session-index';
const roots: string[]=[];
const temp=()=>{const p=fs.mkdtempSync(path.join(os.tmpdir(),'pi-sessions-'));roots.push(p);return p;};
afterEach(()=>{vi.useRealTimers(); roots.splice(0).forEach(p=>fs.rmSync(p,{recursive:true,force:true}));});
const header={type:'session',version:3,id:'s',cwd:'/project/no-longer-present'};
const user={type:'message',id:'a',parentId:null,message:{role:'user',content:'CLI first message',timestamp:1}};
const write=(file:string,entries:unknown[])=>fs.writeFileSync(file,entries.map(e=>JSON.stringify(e)).join('\n')+'\n');
describe('read-only native pi sessions',()=>{
 it('discovers existing sessions without project registration, preserves bytes and mtime',()=>{
  const root=temp(), file=path.join(root,'s.jsonl');write(file,[header,user]);
  const before=fs.readFileSync(file),time=fs.statSync(file).mtimeMs;
  const index=new SessionIndex([root],path.join(root,'desktop'));
  const [s]=index.scan();expect(s.cwd).toBe(header.cwd);expect(s.name).toBe('CLI first message');
  expect(index.history(s.key).branch).toEqual([user]);expect(fs.readFileSync(file)).toEqual(before);expect(fs.statSync(file).mtimeMs).toBe(time);
 });
 it('waits for a complete tail, skips damaged lines and never duplicates entries',()=>{
  const root=temp(), file=path.join(root,'s.jsonl');write(file,[header,user]);
  const index=new SessionIndex([root],path.join(root,'desktop'));const key=index.scan()[0].key;
  fs.appendFileSync(file,'broken\n'+JSON.stringify({type:'message',id:'b',parentId:'a',message:{role:'assistant',content:'later'}}));
  expect(index.history(key).branch).toHaveLength(1);
  fs.appendFileSync(file,'\n');expect(index.history(key).branch).toHaveLength(2);expect(index.history(key).entries).toHaveLength(2);
  expect(index.history(key).session.warnings).toHaveLength(1);
 });
 it('keeps branches separate, handles truncation and deletion',()=>{
  const root=temp(),file=path.join(root,'s.jsonl');
  write(file,[header,user,{type:'message',id:'b',parentId:'a',message:{role:'assistant',content:'one'}},{type:'message',id:'c',parentId:'a',message:{role:'assistant',content:'two'}}]);
  const index=new SessionIndex([root],path.join(root,'desktop'));const key=index.scan()[0].key;
  expect(index.history(key).branch.map(e=>e.id)).toEqual(['a','c']);expect(index.history(key,'b').branch.map(e=>e.id)).toEqual(['a','b']);
  write(file,[header,user]);expect(index.history(key).entries).toHaveLength(1);write(file,[{type:'invalid'}]);expect(index.scan()).toEqual([]);write(file,[header,user]);expect(index.scan()).toHaveLength(1);fs.unlinkSync(file);expect(index.scan()).toEqual([]);
 });
 it('polling catches new directories and appends even without filesystem notification',async()=>{
  const root=temp(), nested=path.join(root,'new');const index=new SessionIndex([nested],path.join(root,'desktop'));const changed=vi.fn();
  index.start(changed);
  try {fs.mkdirSync(nested);write(path.join(nested,'s.jsonl'),[header,user]);await vi.waitFor(()=>expect(changed).toHaveBeenCalled(),{timeout:1900,interval:100});expect(index.scan()).toHaveLength(1);}finally{index.close();}
 });
});
