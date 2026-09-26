import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import { PiBackend } from '../src/main/pi/backend';import { SessionIndex } from '../src/main/pi/session-index';import type { PiEvent } from '../src/shared/pi';
const roots:string[]=[],backends:PiBackend[]=[];
afterEach(()=>{backends.splice(0).forEach(b=>b.dispose());roots.splice(0).forEach(p=>fs.rmSync(p,{recursive:true,force:true}));});
function setup(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-queue-img-'));roots.push(root);const owned=path.join(root,'desktop');fs.mkdirSync(owned,{recursive:true});const index=new SessionIndex([root,owned],owned);const events:PiEvent[]=[];const backend=new PiBackend({executable:path.resolve('tests/fixtures/fake-pi.mjs'),version:'0.85.1',supported:true,agentDir:root,sessionDirs:[root],diagnostics:[]},index,owned,path.resolve('extensions/desktop-policy/index.mjs'),e=>events.push(structuredClone(e)));backends.push(backend);return{root,owned,index,events,backend};}
const img=(tag:string)=>({type:'image' as const,mimeType:'image/png',data:Buffer.from(tag).toString('base64')});
async function running(backend:PiBackend,root:string){const run=await backend.connect({cwd:root,trustProject:false,permission:'ask'});await backend.prompt(run.key,'/long','followUp');await vi.waitFor(()=>expect(backend.runs()[0].status).toBe('running'));return run;}
const promptLog=async(backend:PiBackend,key:string)=>((backend as any).active.get(key).client.request('prompt_log') as Promise<any[]>);
const internals=(backend:PiBackend,key:string)=>(backend as any).active.get(key);

it('attaches staged images to queue_update entries; duplicate text matched by occurrence, no leak to text-only twin',async()=>{
 const {root,backend}=setup();const run=await running(backend,root);
 const A=img('A'),B=img('B');
 await backend.prompt(run.key,'同文','followUp',[A]);
 await backend.prompt(run.key,'同文','followUp');            // 同文本的纯文本排队项
 await backend.prompt(run.key,'另一条','followUp',[B]);
 await vi.waitFor(()=>expect(backend.runs()[0].pending).toBe(3));
 const queue=backend.runs()[0].queue!;
 expect(queue.map(q=>({text:q.text,behavior:q.behavior}))).toEqual([
  {text:'同文',behavior:'followUp'},{text:'同文',behavior:'followUp'},{text:'另一条',behavior:'followUp'}]);
 expect(queue[0].images).toEqual([A]);                        // 第一次出现 → 有图
 expect(queue[1].images).toBeUndefined();                     // 第二次出现 → 纯文本，不错配
 expect(queue[2].images).toEqual([B]);
 // 后续 queue_update（新项入队触发整体重建）后，已关联的图按 carry-over 续接不丢
 await backend.prompt(run.key,'触发重建','followUp');
 await vi.waitFor(()=>expect(backend.runs()[0].pending).toBe(4));
 const again=backend.runs()[0].queue!;
 expect(again[0].images).toEqual([A]);expect(again[1].images).toBeUndefined();expect(again[2].images).toEqual([B]);
 expect(again[3].images).toBeUndefined();
 await backend.stop(run.key);
});

it('clears staged images and the optimistic entry when the prompt RPC fails',async()=>{
 const {root,backend}=setup();const run=await running(backend,root);
 await expect(backend.prompt(run.key,'/failprompt','followUp',[img('A')])).rejects.toThrow('injected prompt failure');
 expect(internals(backend,run.key).queueImages).toEqual([]);  // 暂存不残留
 expect(backend.runs()[0].queue??[]).toEqual([]);              // 乐观项撤回
 expect(backend.runs()[0].pending).toBe(0);
 // 之后的纯文本排队不会被漏配图片
 await backend.prompt(run.key,'正常排队','followUp');
 await vi.waitFor(()=>expect(backend.runs()[0].queue).toEqual([{text:'正常排队',behavior:'followUp'}]));
 await backend.stop(run.key);
});

it('keeps images through queueEdit remove/edit/now and carries them in the re-fired RPC prompt bodies',async()=>{
 const {root,backend}=setup();const run=await running(backend,root);
 const A=img('A'),B=img('B');
 await backend.prompt(run.key,'第一条','followUp',[A]);
 await backend.prompt(run.key,'第二条','followUp');
 await backend.prompt(run.key,'第三条','followUp',[B]);
 await vi.waitFor(()=>expect(backend.runs()[0].pending).toBe(3));
 // remove：剩余项重排后图仍在，且重发的 prompt body 携带图片附件
 await backend.queueEdit(run.key,{type:'remove',index:1});
 await vi.waitFor(()=>expect(backend.runs()[0].queue?.map(q=>q.text)).toEqual(['第一条','第三条']));
 let queue=backend.runs()[0].queue!;
 expect(queue[0].images).toEqual([A]);expect(queue[1].images).toEqual([B]);
 let log=(await promptLog(backend,run.key)).filter(l=>l.message==='第一条'||l.message==='第三条');
 expect(log.map(l=>({m:l.message,imgs:l.images}))).toEqual([{m:'第一条',imgs:[A]},{m:'第三条',imgs:[B]},{m:'第一条',imgs:[A]},{m:'第三条',imgs:[B]}]);
 // edit：改文本保留图，重发 body 带图
 await backend.queueEdit(run.key,{type:'edit',index:1,text:'第三条（改）'});
 await vi.waitFor(()=>expect(backend.runs()[0].queue?.map(q=>q.text)).toEqual(['第一条','第三条（改）']));
 queue=backend.runs()[0].queue!;
 expect(queue[0].images).toEqual([A]);expect(queue[1].images).toEqual([B]);
 log=(await promptLog(backend,run.key)).filter(l=>l.message==='第三条（改）');
 expect(log).toHaveLength(1);expect(log[0].images).toEqual([B]);
 // now：转为 steer 注入，body 带图，视图里 steer 项也接回图
 await backend.queueEdit(run.key,{type:'now',index:0});
 await vi.waitFor(()=>expect(backend.runs()[0].queue?.[0]).toMatchObject({text:'第一条',behavior:'steer'}));
 expect(backend.runs()[0].queue![0].images).toEqual([A]);
 expect(backend.runs()[0].queue![1]).toMatchObject({text:'第三条（改）',behavior:'followUp'});
 log=(await promptLog(backend,run.key)).filter(l=>l.message==='第一条'&&l.behavior==='steer');
 expect(log).toHaveLength(1);expect(log[0].images).toEqual([A]);
 await backend.stop(run.key);
});

it('event sequence: interleaved queue_updates keep unconfirmed stages; transformed text misses safely; stale stages pruned',async()=>{
 const {root,backend}=setup();const run=await running(backend,root);
 const r=internals(backend,run.key);const A=img('A');
 // prompt 已暂存、queue_update 尚未带回该项：中间到达的不含该项的 queue_update 不得清掉暂存
 r.queueImages.push({text:'晚到',behavior:'followUp',images:[A],at:Date.now()});
 (backend as any).onEvent(r,{type:'queue_update',steering:[],followUp:['别的']});
 expect(r.queueImages).toHaveLength(1);
 expect(backend.runs()[0].queue).toEqual([{text:'别的',behavior:'followUp'}]);
 (backend as any).onEvent(r,{type:'queue_update',steering:[],followUp:['别的','晚到']});
 expect(backend.runs()[0].queue![1].images).toEqual([A]);
 expect(r.queueImages).toHaveLength(0);                       // 已确认的暂存被消费
 // pi 改写了文本：安全落空，不把图配给文本不同的项
 r.queueImages.push({text:'原文',behavior:'followUp',images:[A],at:Date.now()});
 (backend as any).onEvent(r,{type:'queue_update',steering:[],followUp:['原文（被 pi 改写）']});
 expect(backend.runs()[0].queue![0]).toEqual({text:'原文（被 pi 改写）',behavior:'followUp'});
 // 陈旧暂存（从未被确认）过期清理，不配给后来的同文项
 r.queueImages.length=0;
 r.queueImages.push({text:'旧',behavior:'followUp',images:[A],at:Date.now()-121_000});
 (backend as any).onEvent(r,{type:'queue_update',steering:[],followUp:['旧']});
 expect(backend.runs()[0].queue![0].images).toBeUndefined();
 expect(r.queueImages).toHaveLength(0);
 await backend.stop(run.key);
});

it('does not double-assign staged images: optimistic pendingSync entry consumes its paired stage',async()=>{
 const {root,backend}=setup();const run=await running(backend,root);
 const r=internals(backend,run.key);const A=img('A');
 // prompt 乐观入 view（pendingSync+图）且 sidecar 有成双登记，queue_update 尚未到达
 r.view.queue=[{text:'同',behavior:'followUp',images:[A],pendingSync:true}];r.view.pending=1;
 r.queueImages.push({text:'同',behavior:'followUp',images:[A],at:Date.now()});
 (backend as any).onEvent(r,{type:'queue_update',steering:[],followUp:['同','同']});
 const queue=backend.runs()[0].queue!;
 expect(queue[0].images).toEqual([A]);                        // 乐观项的图接续
 expect(queue[1].images).toBeUndefined();                     // 成双登记已一并消费，纯文本同文项不得分到图
 expect(r.queueImages).toHaveLength(0);
 await backend.stop(run.key);
});

it('stop clears the image sidecar along with the queue',async()=>{
 const {root,backend}=setup();const run=await running(backend,root);
 await backend.prompt(run.key,'带图排队','followUp',[img('A')]);
 await vi.waitFor(()=>expect(backend.runs()[0].pending).toBe(1));
 expect(internals(backend,run.key).queueImages).toEqual([]); // 已被 queue_update 确认消费
 internals(backend,run.key).queueImages.push({text:'未确认',behavior:'followUp',images:[img('X')],at:Date.now()});
 await backend.stop(run.key);
 expect(internals(backend,run.key).queueImages).toEqual([]);
 expect(backend.runs()[0].queue).toEqual([]);
});
