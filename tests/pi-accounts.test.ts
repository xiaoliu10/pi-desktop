import {it,expect} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PiAccounts} from '../src/main/pi/accounts';

it('reads subscription model metadata from bundled pi without leaking credentials',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pi-accounts-'));
 const accounts=new PiAccounts(()=>dir);
 try {
  fs.writeFileSync(path.join(dir,'auth.json'),JSON.stringify({'openai-codex':{type:'oauth',access:'test-access-secret',refresh:'test-refresh-secret',expires:Date.now()+3600000}}));
  const providers=await accounts.catalog();
  const codex=providers.find(p=>p.id==='openai-codex');
  expect(codex).toMatchObject({auth:'oauth',loginAvailable:true,source:'auth'});
  expect(codex?.models.length).toBeGreaterThan(0);
  expect(codex?.models[0]).toHaveProperty('contextWindow');
  expect(JSON.stringify(providers)).not.toContain('test-access-secret');
  expect(JSON.stringify(providers)).not.toContain('test-refresh-secret');
  expect(providers.some(p=>p.loginAvailable&&p.auth==='none')).toBe(true);
 } finally {accounts.dispose();fs.rmSync(dir,{recursive:true,force:true});}
},30000);

it('rejects expired login responses and untrusted external URL requests',()=>{
 const accounts=new PiAccounts(()=>'/tmp/unused-pi-accounts');
 expect(()=>accounts.status('unknown')).toThrow('失效');
 expect(()=>accounts.answer('unknown','1','secret')).toThrow('失效');
 expect(()=>accounts.url('unknown')).toThrow('失效');
});

import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {vi} from 'vitest';
function fakeLogin() {
 const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill:vi.fn()});
 const accounts=new PiAccounts(()=>'/tmp/unused-pi-accounts');
 vi.spyOn(accounts as any,'spawn').mockReturnValue(child);
 const start=accounts.start('openai-codex');
 const send=(message:unknown)=>child.stdout.write(JSON.stringify(message)+'\n');
 return {accounts,child,start,send};
}
it('bridges prompts, clears expired prompts, and never returns submitted codes',()=>{
 const {accounts,child,start,send}=fakeLogin();
 try{
  expect(()=>accounts.start('other')).toThrow('已有');
  send({type:'notify',event:{type:'auth_url',url:'https://example.com/oauth',instructions:'Sign in'}});
  expect(accounts.url(start.id)).toBe('https://example.com/oauth');
  send({type:'prompt',prompt:{id:'1',type:'manual_code',message:'Paste code'}});
  accounts.answer(start.id,'1','sensitive-auth-code');
  expect(JSON.stringify(accounts.status(start.id))).not.toContain('sensitive-auth-code');
  expect(()=>accounts.answer(start.id,'1','again')).toThrow('失效');
  send({type:'prompt',prompt:{id:'2',type:'manual_code',message:'Waiting'}});
  send({type:'prompt-closed',id:'2'});
  expect(accounts.status(start.id).prompt).toBeUndefined();
  send({type:'done'});
  expect(accounts.status(start.id)).toMatchObject({status:'done',url:undefined,prompt:undefined});
  expect(()=>accounts.url(start.id)).toThrow();
 }finally{child.emit('close');accounts.dispose();}
});
it('cancels login and ignores messages from an old attempt',()=>{
 const {accounts,child,start,send}=fakeLogin();
 send({type:'notify',event:{type:'auth_url',url:'file:///etc/passwd'}});
 expect(()=>accounts.url(start.id)).toThrow();
 accounts.cancel(start.id);
 send({type:'done'});
 expect(accounts.status(start.id).status).toBe('cancelled');
 child.emit('close');
 accounts.dispose();
});
