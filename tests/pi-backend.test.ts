import { afterEach, expect, it, vi } from 'vitest';
import * as childProcess from 'node:child_process';
vi.mock('node:child_process', async importOriginal => {
 const actual = await importOriginal<typeof import('node:child_process')>();
 return { ...actual, spawn: vi.fn(actual.spawn) };
});
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import { PiBackend } from '../src/main/pi/backend';import { SessionIndex } from '../src/main/pi/session-index';import type { PiEvent } from '../src/shared/pi';
const roots:string[]=[],backends:PiBackend[]=[];
afterEach(()=>{backends.splice(0).forEach(b=>b.dispose());roots.splice(0).forEach(p=>fs.rmSync(p,{recursive:true,force:true}));});
function setup(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-backend-'));roots.push(root);const owned=path.join(root,'desktop');fs.mkdirSync(owned,{recursive:true});const index=new SessionIndex([root,owned],owned);const events:PiEvent[]=[];const backend=new PiBackend({executable:path.resolve('tests/fixtures/fake-pi.mjs'),version:'0.85.1',supported:true,agentDir:root,sessionDirs:[root],diagnostics:[]},index,owned,path.resolve('extensions/desktop-policy/index.mjs'),e=>events.push(structuredClone(e)));backends.push(backend);return{root,owned,index,events,backend};}
it('launch injects the session project cwd and memory directory into the child environment', async () => {
 const { root, backend } = setup();
 backend.memoryOptions = () => ({ enabled: true, dir: path.join(root, 'memory') });
 const spawn = vi.mocked(childProcess.spawn);
 spawn.mockClear();
 try {
  await backend.connect({ cwd: root, trustProject: false, permission: 'ask' });
  const options = spawn.mock.calls[0][2] as childProcess.SpawnOptions;
  expect(options.env).toMatchObject({ PI_DESKTOP_MEMORY: '1', PI_DESKTOP_MEMORY_DIR: path.join(root, 'memory'), PI_DESKTOP_MEMORY_CWD: root });
  // Project session: pi-memory 0.4.2 per-project root + qmd reindex/search off (names per plugin README).
  expect(options.env).toMatchObject({ PI_MEMORY_DIR: path.join(root, '.pi', 'memory'), PI_MEMORY_QMD_UPDATE: 'off', PI_MEMORY_NO_SEARCH: '1' });
 } finally { spawn.mockClear(); }
});
it('project launch replaces stale inherited PI_MEMORY_* scope with the recomputed project root', async () => {
 const { root, backend } = setup();
 backend.memoryOptions = () => ({ enabled: true, dir: path.join(root, 'memory') });
 vi.stubEnv('PI_MEMORY_DIR', '/stale-global-memory'); vi.stubEnv('PI_MEMORY_QMD_UPDATE', 'background'); vi.stubEnv('PI_MEMORY_NO_SEARCH', '1');
 const spawn = vi.mocked(childProcess.spawn); spawn.mockClear();
 try {
  await backend.connect({ cwd: root, trustProject: false, permission: 'ask' });
  const options = spawn.mock.calls[0][2] as childProcess.SpawnOptions;
  expect(options.env?.PI_MEMORY_DIR).toBe(path.join(root, '.pi', 'memory'));
  expect(options.env?.PI_MEMORY_QMD_UPDATE).toBe('off');
  expect(options.env?.PI_MEMORY_NO_SEARCH).toBe('1');
 } finally { vi.unstubAllEnvs(); spawn.mockClear(); }
});
it('memory launch clears inherited enable/scope variables when disabled', async () => {
 const { root, backend } = setup();
 vi.stubEnv('PI_DESKTOP_MEMORY', '1'); vi.stubEnv('PI_DESKTOP_MEMORY_CWD', '/other-project'); vi.stubEnv('PI_DESKTOP_MEMORY_DIR', '/other-memory');
 vi.stubEnv('PI_MEMORY_DIR', '/stale-global-memory'); vi.stubEnv('PI_MEMORY_QMD_UPDATE', 'background'); vi.stubEnv('PI_MEMORY_NO_SEARCH', '1');
 const spawn = vi.mocked(childProcess.spawn); spawn.mockClear();
 try {
  await backend.connect({ cwd: root, trustProject: false, permission: 'ask' });
  const options = spawn.mock.calls[0][2] as childProcess.SpawnOptions;
  expect(options.env?.PI_DESKTOP_MEMORY).toBeUndefined();
  expect(options.env?.PI_DESKTOP_MEMORY_CWD).toBeUndefined();
  expect(options.env?.PI_DESKTOP_MEMORY_DIR).toBeUndefined();
  // Disabled memory: pi-memory vars stay unset too — the plugin must fall back to its global default.
  expect(options.env?.PI_MEMORY_DIR).toBeUndefined();
  expect(options.env?.PI_MEMORY_QMD_UPDATE).toBeUndefined();
  expect(options.env?.PI_MEMORY_NO_SEARCH).toBeUndefined();
  expect(spawn.mock.calls[0][1]).not.toContain(path.resolve('extensions/desktop-memory/index.mjs'));
 } finally { vi.unstubAllEnvs(); spawn.mockClear(); }
});
it('opens a new copy and never writes the external CLI session; redacts model metadata',async()=>{
 const {root,index,backend}=setup(),file=path.join(root,'cli.jsonl');const original=JSON.stringify({type:'session',version:3,id:'cli',cwd:root})+'\n';fs.writeFileSync(file,original);
 const session=index.scan()[0];const run=await backend.connect({sourceKey:session.key,trustProject:false,permission:'ask'});
 expect(run.file).not.toBe(file);expect(fs.readFileSync(file,'utf8')).toBe(original);expect(JSON.stringify(run)).not.toContain('DO NOT EXPOSE');expect(JSON.parse(fs.readFileSync(run.file,'utf8').split('\n')[0]).parentSession).toBe(fs.realpathSync(file));
});
it('re-attaches to an already connected session instead of double-opening the file',async()=>{
 const{root,index,backend}=setup();const file=path.join(root,'cli.jsonl');fs.writeFileSync(file,JSON.stringify({type:'session',version:3,id:'cli',cwd:root})+'\n');
 const session=index.scan()[0];const run=await backend.connect({sourceKey:session.key,trustProject:false,permission:'ask'});
 const again=await backend.connect({sourceKey:session.key,trustProject:false,permission:'ask'});
 expect(again.key).toBe(run.key);expect(again.generation).toBe(run.generation);expect(backend.runs().length).toBe(1);
});
it('forks an external CLI session once, then resumes the Desktop copy in place',async()=>{
 const{root,index,backend}=setup();const file=path.join(root,'cli.jsonl');fs.writeFileSync(file,JSON.stringify({type:'session',version:3,id:'cli',cwd:root})+'\n');
 const session=index.scan()[0];const copy=await backend.connect({sourceKey:session.key,trustProject:false,permission:'ask'});
 await backend.prompt(copy.key,'hi','followUp');await vi.waitFor(()=>expect(backend.runs()[0].status).toBe('idle'));
 // Drop the run (crash path), then continue from the Desktop copy: same file, no new fork.
 await expect(backend.prompt(copy.key,'/crash','followUp')).rejects.toThrow('退出');
 await vi.waitFor(()=>expect(backend.runs()).toEqual([]));
 const resumed=await backend.connect({sourceKey:copy.key,trustProject:false,permission:'ask'});
 expect(resumed.file).toBe(copy.file);
 expect(index.scan().filter(s=>s.cwd===root).length).toBe(2); // 原件 + 副本，不再增多
});
it('reports context usage from connect onward and refreshes after each settled turn', async () => {
 const {root,backend}=setup();const run=await backend.connect({cwd:root,trustProject:false,permission:'ask'});
 await vi.waitFor(()=>expect(backend.runs()[0].contextUsage).toEqual({tokens:1200,contextWindow:200000,percent:1}));
 await backend.prompt(run.key,'hi','followUp');
 await vi.waitFor(()=>expect(backend.runs()[0].status).toBe('idle'));
 expect(backend.runs()[0].contextUsage).toEqual({tokens:1200,contextWindow:200000,percent:1});
});
it('computes proportional breakdown and cache hit rate from the active transcript', async () => {
 const {root,backend}=setup();const run=await backend.connect({cwd:root,trustProject:false,permission:'ask'});
 await vi.waitFor(()=>expect(backend.runs()[0].contextDetails?.breakdown.length).toBeGreaterThan(0));
 const details=backend.runs()[0].contextDetails!;
 expect(details.method).toBe('active-transcript-chars');
 const by=Object.fromEntries(details.breakdown.map(b=>[b.category,b.chars]));
 expect(by.messages).toBeGreaterThan(0);
 expect(by.systemPrompt).toBeGreaterThanOrEqual(by.skills);
 expect(details.cacheHitRate).toBeCloseTo(1000/3000*100, 5); // 1000/(1000+0+2000)
});
it('clears stale context usage and ignores out-of-order statistics', async () => {
 const {root,backend}=setup();const view=await backend.connect({cwd:root,trustProject:false,permission:'ask'});
 await vi.waitFor(()=>expect(backend.runs()[0].contextUsage).toBeDefined());
 const internals=backend as any, run=internals.active.get(view.key);
 const pending:Array<(data:unknown)=>void>=[];
 const spy=vi.spyOn(run.client,'request').mockImplementation(()=>new Promise(resolve=>pending.push(resolve)));
 try {
  internals.refreshContextUsage(run);internals.refreshContextUsage(run);
  pending[1]({contextUsage:{tokens:null,contextWindow:200000,percent:null}});
  await vi.waitFor(()=>expect(backend.runs()[0].contextUsage).toBeUndefined());
  pending[0]({contextUsage:{tokens:100000,contextWindow:200000,percent:50}});
  await Promise.resolve();expect(backend.runs()[0].contextUsage).toBeUndefined();
 } finally {spy.mockRestore();}
});
it('does not consider agent_end final while retries are pending',async()=>{const{root,backend}=setup();const run=await backend.connect({cwd:root,trustProject:false,permission:'ask'});await backend.prompt(run.key,'hi','followUp');await vi.waitFor(()=>expect(backend.runs()[0].status).toBe('running'));await vi.waitFor(()=>expect(backend.runs()[0].status).toBe('idle'));});
it('routes UI only to the matching generation and resolves it during stop',async()=>{
 const{root,backend,events}=setup();const run=await backend.connect({cwd:root,trustProject:false,permission:'ask'});
 const pending=backend.prompt(run.key,'/dialog','followUp');await vi.waitFor(()=>expect(events.some(e=>e.type==='ui' && e.request.id==='dialog')).toBe(true));
 expect(()=>backend.respond(run.key,'old',{id:'dialog',confirmed:true})).toThrow('过期');
 await backend.stop(run.key);await pending;expect(backend.runs()[0].status).toBe('idle');
 expect(events.some(e=>e.type==='rpc'&&e.key===run.key&&e.generation===run.generation&&e.event.type==='ui-expired'&&e.event.id==='dialog')).toBe(true);
 expect(()=>backend.respond(run.key,run.generation,{id:'dialog',confirmed:true})).toThrow('过期');
});
it('rejects refresh with an unanswered dialog',async()=>{const{root,backend,events}=setup();const run=await backend.connect({cwd:root,trustProject:false,permission:'ask'});const pending=backend.prompt(run.key,'/dialog','followUp');await vi.waitFor(()=>expect(events.some(e=>e.type==='ui' && e.request.id==='dialog')).toBe(true));await expect(backend.refresh(run.key)).rejects.toThrow('等待交互');backend.respond(run.key,run.generation,{id:'dialog',cancelled:true});await pending;});

it('snapshots pending dialogs with generation and full request, and emits ui-resolved on respond',async()=>{
 const{root,backend,events}=setup();const run=await backend.connect({cwd:root,trustProject:false,permission:'ask'});
 expect(backend.pendingDialogs(run.key)).toEqual([]);
 const pending=backend.prompt(run.key,'/dialog','followUp');
 await vi.waitFor(()=>expect(events.some(e=>e.type==='ui' && e.request.id==='dialog')).toBe(true));
 const snapshot=backend.pendingDialogs(run.key);
 expect(snapshot).toEqual([{generation:run.generation,request:expect.objectContaining({id:'dialog',method:'confirm',title:'Confirm?'})}]);
 expect(backend.pendingDialogs('nope')).toEqual([]);
 backend.respond(run.key,run.generation,{id:'dialog',confirmed:true});
 expect(events.some(e=>e.type==='rpc'&&e.key===run.key&&e.generation===run.generation&&e.event.type==='ui-resolved'&&e.event.id==='dialog')).toBe(true);
 await pending;
 expect(backend.pendingDialogs(run.key)).toEqual([]);
});

it('forks back to an entry only while idle and without pending dialogs (edit-and-resend)',async()=>{
 const{root,backend,events}=setup();const run=await backend.connect({cwd:root,trustProject:false,permission:'ask'});
 expect(backend.forkTo(run.key,'')).rejects.toThrow('消息条目无效');
 await expect(backend.forkTo(run.key,'entry-1')).resolves.toBe('forked text');
 // 运行中拒绝编辑
 const long=backend.prompt(run.key,'/long','followUp');
 await vi.waitFor(()=>expect(backend.runs()[0].status).toBe('running'));
 await expect(backend.forkTo(run.key,'entry-1')).rejects.toThrow('请先停止当前任务');
 await backend.stop(run.key);await long;
 // 待审批对话阻塞编辑
 const pending=backend.prompt(run.key,'/dialog','followUp');
 await vi.waitFor(()=>expect(events.some(e=>e.type==='ui'&&e.request.id==='dialog')).toBe(true));
 await expect(backend.forkTo(run.key,'entry-1')).rejects.toThrow('等待交互');
 backend.respond(run.key,run.generation,{id:'dialog',cancelled:true});await pending;
});

it('shows compacting during compaction and repairs wiped package registrations on launch',async()=>{
 const{root,index,owned}=setup();
 // 模拟 pi 会话写回旧副本：期望列表里有 pi-goal-x，settings.json 里被抹掉
 const dataDir=path.join(root,'desktop-data');fs.mkdirSync(dataDir,{recursive:true});
 fs.writeFileSync(path.join(dataDir,'pi-desktop.json'),JSON.stringify({piPackages:['npm:pi-memory','npm:pi-goal-x']}));
 fs.writeFileSync(path.join(root,'settings.json'),JSON.stringify({theme:'x',packages:['npm:pi-memory']}));
 const backend2=new PiBackend({executable:path.resolve('tests/fixtures/fake-pi.mjs'),version:'0.85.1',supported:true,agentDir:root,sessionDirs:[root],diagnostics:[]},index,owned,path.resolve('extensions/desktop-policy/index.mjs'),()=>{},dataDir);backends.push(backend2);
 const run=await backend2.connect({cwd:root,trustProject:false,permission:'ask'});
 const packages=JSON.parse(fs.readFileSync(path.join(root,'settings.json'),'utf8')).packages;
 expect(packages).toContain('npm:pi-goal-x');expect(packages).toContain('npm:pi-memory');
 // 压缩指示：compaction_start → compacting=true（状态 running），end → false
 await backend2.prompt(run.key,'/compact-start','followUp');
 await vi.waitFor(()=>expect(backend2.runs()[0]?.compacting).toBe(true));
 expect(backend2.runs()[0]?.status).toBe('running');
 await backend2.prompt(run.key,'/compact-end','followUp');
 await vi.waitFor(()=>expect(backend2.runs()[0]?.compacting).toBe(false));
 await vi.waitFor(()=>expect(backend2.runs()[0]?.status).toBe('idle'));
});

it('compact: success settles normally; token-cap failure collapses the fake running state and rethrows an actionable message',async()=>{
 const{root,backend}=setup();const run=await backend.connect({cwd:root,trustProject:false,permission:'ask'});
 // 成功：直接调用 RPC compact（状态本就 idle，收口无副作用）
 await expect(backend.compact(run.key)).resolves.toMatchObject({summary:'fake summary'});
 // 失败：真实链路——idle 时发起 compact，pi 发 compaction_start（状态转 running）后摘要截断拒绝，
 // 收口必须把状态拉回 idle（否则假转圈：重试/发送/重载全被 guard 拒绝）
 await expect(backend.compact(run.key,'CAP')).rejects.toThrow('压缩失败：摘要生成达到模型输出上限被截断');
 expect(backend.runs()[0]?.status).toBe('idle');
 expect(backend.runs()[0]?.compacting).toBe(false);
 // 收口后重试不再被「请在任务空闲时压缩」guard 拒绝（guard 直接放行到 fake 的成功分支）
 await expect(backend.compact(run.key)).resolves.toMatchObject({summary:'fake summary'});
});

it('fails closed when the mandatory policy extension is missing',async()=>{const {root,index,owned}=setup();const backend=new PiBackend({executable:path.resolve('tests/fixtures/fake-pi.mjs'),version:'0.85.1',supported:true,agentDir:root,sessionDirs:[root],diagnostics:[]},index,owned,path.join(root,'missing.mjs'),()=>{});backends.push(backend);await expect(backend.connect({cwd:root,trustProject:false,permission:'ask'})).rejects.toThrow('权限扩展缺失');expect(backend.runs()).toEqual([]);});

it('releases ownership when pi unexpectedly exits',async()=>{const{root,backend}=setup();const run=await backend.connect({cwd:root,trustProject:false,permission:'ask'});await expect(backend.prompt(run.key,'/crash','followUp')).rejects.toThrow('退出');await vi.waitFor(()=>expect(backend.runs()).toEqual([]));});

it('keeps one start time through retries and freezes elapsed time only when settled', async () => {
 const { root, backend, events } = setup();
 const run = await backend.connect({ cwd: root, trustProject: false, permission: 'ask' });
 await backend.prompt(run.key, 'hi', 'followUp');
 await vi.waitFor(() => expect(backend.runs()[0].timing?.endedAt).toBeTypeOf('number'));
 const snapshots = events.filter((e): e is Extract<PiEvent, { type: 'run' }> => e.type === 'run' && !!e.run.timing);
 const timing = backend.runs()[0].timing!;
 expect(new Set(snapshots.map(e => e.run.timing!.startedAt)).size).toBe(1);
 expect(snapshots.filter(e => e.run.status === 'running').every(e => e.run.timing!.endedAt === undefined)).toBe(true);
 expect(timing.endedAt!).toBeGreaterThanOrEqual(timing.startedAt);
});

it('switches policy with a new runtime generation and preserves session and execution mode', async () => {
 const {root,backend}=setup();
 const run=await backend.connect({cwd:root,trustProject:false,permission:'autoEdit'});
 const plan=await backend.setAccessMode(run.key,'plan');
 expect(plan.generation).toBe(run.generation); expect(plan.file).toBe(run.file);
 expect(plan.accessMode).toBe('plan'); expect(plan.executionMode).toBe('autoEdit');
 await expect(backend.prompt(plan.key,'/command','followUp')).rejects.toThrow('斜杠命令');
 const refreshed=await backend.refresh(plan.key); expect(refreshed.executionMode).toBe('autoEdit');
 const execute=await backend.setAccessMode(plan.key,refreshed.executionMode!); expect(execute.accessMode).toBe('autoEdit');
});
it('applies mode changes live while a task is running and persists them across restarts',async()=>{
 const {root,backend,events}=setup(); const run=await backend.connect({cwd:root,trustProject:false,permission:'ask'});
 await backend.prompt(run.key,'hi','followUp');
 await vi.waitFor(()=>expect(backend.runs()[0].status).toBe('running'));
 const changed=await backend.setAccessMode(run.key,'fullAccess');
 expect(changed.accessMode).toBe('fullAccess');
 expect(backend.runs()[0].accessMode).toBe('fullAccess');
 expect(events.some(e=>e.type==='run'&&e.run.accessMode==='fullAccess')).toBe(true);
 // restart path keeps the new mode
 await vi.waitFor(()=>expect(backend.runs()[0].status).toBe('idle'));
 const refreshed=await backend.refresh(run.key);
 expect(refreshed.accessMode).toBe('fullAccess');
 await backend.stop(run.key);
});
it('rejects mode changes while awaiting approval and rejects invalid modes',async()=>{
 const {root,backend,events}=setup(); const run=await backend.connect({cwd:root,trustProject:false,permission:'ask'});
 const pending=backend.prompt(run.key,'/dialog','followUp');
 await vi.waitFor(()=>expect(events.some(e=>e.type==='ui'&&e.request.id==='dialog')).toBe(true));
 await expect(backend.setAccessMode(run.key,'fullAccess')).rejects.toThrow('待确认');
 backend.respond(run.key,run.generation,{id:'dialog',cancelled:true}); await pending;
 await expect(backend.setAccessMode(run.key,'invalid' as any)).rejects.toThrow('无效');
 expect(backend.runs()[0].accessMode).toBe('ask');
});
it('surfaces queued follow-ups from queue_update while a task is running',async()=>{
 const {root,backend,events}=setup(); const run=await backend.connect({cwd:root,trustProject:false,permission:'ask'});
 await backend.prompt(run.key,'/long','followUp');
 await vi.waitFor(()=>expect(backend.runs()[0].status).toBe('running'));
 await backend.prompt(run.key,'第二条追问','followUp');
 await vi.waitFor(()=>expect(backend.runs()[0].pending).toBe(1));
 expect(backend.runs()[0].queue).toEqual([{text:'第二条追问',behavior:'followUp'}]);
 expect((events.filter(e=>e.type==='run').at(-1)).run.pending).toBe(1);
 await backend.stop(run.key);
 expect(backend.runs()[0].pending).toBe(0);
});
it('queueEdit removes, edits and promotes queued follow-ups via clear + re-queue',async()=>{
 const {root,backend}=setup(); const run=await backend.connect({cwd:root,trustProject:false,permission:'ask'});
 await backend.prompt(run.key,'/long','followUp');
 await vi.waitFor(()=>expect(backend.runs()[0].status).toBe('running'));
 await backend.prompt(run.key,'第一条','followUp'); await backend.prompt(run.key,'第二条','followUp');
 await vi.waitFor(()=>expect(backend.runs()[0].pending).toBe(2));
 // 删除第一条
 await backend.queueEdit(run.key,{type:'remove',index:0});
 await vi.waitFor(()=>expect(backend.runs()[0].queue).toEqual([{text:'第二条',behavior:'followUp'}]));
 // 编辑剩下的那条
 await backend.queueEdit(run.key,{type:'edit',index:0,text:'第二条（改）'});
 await vi.waitFor(()=>expect(backend.runs()[0].queue).toEqual([{text:'第二条（改）',behavior:'followUp'}]));
 // 立即：转为 steer 注入当前运行，其余重新排队
 await backend.prompt(run.key,'第三条','followUp');
 await vi.waitFor(()=>expect(backend.runs()[0].pending).toBe(2));
 await backend.queueEdit(run.key,{type:'now',index:1});
 await vi.waitFor(()=>expect(backend.runs()[0].queue).toEqual([{text:'第三条',behavior:'steer'},{text:'第二条（改）',behavior:'followUp'}]));
 // 非法操作
 await expect(backend.queueEdit(run.key,{type:'remove',index:9})).rejects.toThrow('队列项不存在');
 await expect(backend.queueEdit(run.key,{type:'edit',index:0,text:'  '})).rejects.toThrow('内容为空');
 await backend.stop(run.key);
});
it('reads back xhigh, max and off from the CLI after switching',async()=>{
 const {root,backend}=setup(); const run=await backend.connect({cwd:root,trustProject:false,permission:'ask'});
 for (const level of ['xhigh','max','off'] as const) {
  const updated=await backend.thinking(run.key,level);
  expect(updated.thinkingLevel).toBe(level);
  expect(backend.runs()[0].thinkingLevel).toBe(level);
 }
});
it('model and thinking switches made while running queue up and apply at the next message boundary',async()=>{
 const {root,backend}=setup(); const run=await backend.connect({cwd:root,trustProject:false,permission:'ask'});
 await backend.prompt(run.key,'/long','followUp');
 await vi.waitFor(()=>expect(backend.runs()[0].status).toBe('running'));
 // 运行中切换 → 挂起为待生效，不直接下发
 const queuedModel = await backend.model(run.key,'test','fake-model');
 expect(queuedModel.pendingModel).toEqual({provider:'test',id:'fake-model'});
 expect(backend.runs()[0].status).toBe('running');
 await backend.thinking(run.key,'high');
 expect(backend.runs()[0].pendingThinking).toBe('high');
 // 无效模型仍然立即报错
 await expect(backend.model(run.key,'test','nope')).rejects.toThrow('可用列表');
 await expect(backend.thinking(run.key,'bogus' as any)).rejects.toThrow('未知的思考等级');
 // 一次模型调用结束（assistant message_end 边界）→ 挂起项统一下发
 await backend.prompt(run.key,'/boundary','followUp');
 await vi.waitFor(()=>expect(backend.runs()[0].pendingModel).toBeUndefined());
 await vi.waitFor(()=>expect(backend.runs()[0].pendingThinking).toBeUndefined());
 await vi.waitFor(()=>expect(backend.runs()[0].model?.id).toBe('fake-model'));
 await vi.waitFor(()=>expect(backend.runs()[0].thinkingLevel).toBe('high'));
 expect(backend.runs()[0].status).toBe('running');
 // 运行结束（agent_settled 边界）也能应用剩余的挂起项
 await backend.thinking(run.key,'low');
 await backend.prompt(run.key,'/endlong','followUp');
 await vi.waitFor(()=>expect(backend.runs()[0].status).toBe('idle'));
 await vi.waitFor(()=>expect(backend.runs()[0].thinkingLevel).toBe('low'));
 // 空闲时切换保持原有直发路径
 const direct = await backend.model(run.key,'test','fake-model');
 expect(direct.pendingModel).toBeUndefined();
 expect(backend.runs()[0].pendingThinking).toBeUndefined();
});
it('reuses the active writer when opening a Desktop-owned session by file key',async()=>{
 const {root,index,backend}=setup();const run=await backend.connect({cwd:root,trustProject:false,permission:'ask'});
 fs.writeFileSync(run.file,JSON.stringify({type:'session',version:3,id:'desktop',cwd:root})+'\n');
 const selected=index.scan().find(s=>s.key===run.key)!;expect(selected).toBeDefined();
 const again=await backend.connect({sourceKey:selected.key,trustProject:false,permission:'ask'});
 expect(again.generation).toBe(run.generation);expect(backend.runs()).toHaveLength(1);
});

it('slash commands: initial fetch is filtered; connect schedules one late-load recheck', async () => {
 const spy = vi.spyOn(global, 'setTimeout');
 try {
  const { backend } = setup();
  await backend.connect({ cwd: '/', trustProject: false, permission: 'ask' });
  // 初次：1 条（fake 第 1 次）。
  expect(backend.runs()[0].commands.map(c => c.name)).toEqual(['hello']);
  // 连接完成时调度了迟加载复检定时器（8s 档）。
  expect(spy.mock.calls.some(([, delay]) => delay === 8000)).toBe(true);
 } finally { spy.mockRestore(); }
});

it('slash commands: refreshCommands re-pulls on demand, never shrinks, and dedupes repeat broadcasts', async () => {
 const { backend, events } = setup();
 const run = await backend.connect({ cwd: '/', trustProject: false, permission: 'ask' });
 expect(backend.runs()[0].commands.map(c => c.name)).toEqual(['hello']);
 // 第 2 次拉取（fake 迟加载列表）：3 条 + desktop-retry 被滤 → 3 条。
 expect(await backend.refreshCommands(run.key)).toBe(3);
 expect(backend.runs()[0].commands.map(c => c.name)).toEqual(['hello', 'goal', 'goal-resume']);
 // 第 3 次拉取结果不再多于当前：不广播、不回退。
 const namesBefore = backend.runs()[0].commands.map(c => c.name);
 expect(await backend.refreshCommands(run.key)).toBe(3);
 // 不回退：重复拉取后命令集合保持稳定（迟加载复检/按需拉取幂等）。
 expect(backend.runs()[0].commands.map(c => c.name)).toEqual(namesBefore);
 expect(backend.runs()[0].commands.map(c => c.name)).toEqual(['hello', 'goal', 'goal-resume']);
 void run;
});
it('compaction_end with result emits compaction-record (after tokens backfill anchor)',async()=>{
 const {backend,events}=setup();
 const run=await backend.connect({cwd:process.cwd(),trustProject:false,permission:'ask'});
 await backend.prompt(run.key,'/compact-end-result','followUp');
 await vi.waitFor(()=>expect(events.some(e=>e.type==='compaction-record')).toBe(true));
 const record=events.find(e=>e.type==='compaction-record') as Extract<PiEvent,{type:'compaction-record'}>;
 expect(record.tokensAfter).toBe(35000);
 expect(record.contextWindow).toBe(400000);
 // 渲染层契约：at 必须等于留痕 entry 的 data.at（不是 fallback 的 Date.now()）——±15s 匹配窗口靠它。
 const line=fs.readFileSync(run.file,'utf8').split('\n').find(l=>l.includes('desktop-compaction'));
 expect(record.at).toBe(Number(JSON.parse(line!).data.at));
});
it('compaction_end without result (aborted) does NOT emit compaction-record',async()=>{
 const {backend,events}=setup();
 const run=await backend.connect({cwd:process.cwd(),trustProject:false,permission:'ask'});
 await backend.prompt(run.key,'/compact-end','followUp');
 await vi.waitFor(()=>expect(backend.runs()[0]?.compacting).toBe(false));
 await new Promise(r=>setTimeout(r,300));
 expect(events.some(e=>e.type==='compaction-record')).toBe(false);
});
