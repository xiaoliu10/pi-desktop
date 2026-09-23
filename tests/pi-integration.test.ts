import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { PiBackend } from '../src/main/pi/backend';import { SessionIndex } from '../src/main/pi/session-index';import { discoverPi } from '../src/main/pi/environment';import type { PiEvent } from '../src/shared/pi';
const roots:string[]=[],backends:PiBackend[]=[];let server:http.Server | undefined;
afterEach(async()=>{backends.splice(0).forEach(b=>b.dispose());if(server){server.closeAllConnections();await new Promise<void>(r=>server!.close(()=>r()));server=undefined;}roots.splice(0).forEach(p=>fs.rmSync(p,{recursive:true,force:true}));});
const real=process.env.PI_TEST_RUNTIME==='bundled' ? 'bundled' : process.env.PI_TEST_EXECUTABLE;
it.skipIf(!real)('runs real pi with an isolated extension UI and local SSE model; no external model service',async()=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'pi-real-')));roots.push(root);const agent=path.join(root,'agent'),project=path.join(root,'project'),owned=path.join(agent,'sessions/desktop');
 fs.mkdirSync(path.join(agent,'extensions'),{recursive:true});fs.mkdirSync(project);fs.writeFileSync(path.join(project,'example.txt'),'original');
 fs.writeFileSync(path.join(agent,'extensions/ui.ts'),`export default function(pi) { pi.registerCommand('desktop-wait', { handler: async (_args,ctx) => { const answer=await ctx.ui.confirm('wait','cancel me');pi.appendEntry('desktop-cancel',{answer}); } }); pi.registerCommand('desktop-ui-test', { handler: async (_args,ctx) => { ctx.ui.setStatus('test','ready');ctx.ui.setWidget('test',['line 1','line 2']);const yes=await ctx.ui.confirm('test confirm','confirm');const value=await ctx.ui.input('test input');const option=await ctx.ui.select('test select',['A','B']);const edited=await ctx.ui.editor('test editor','prefill');pi.appendEntry('desktop-test',{yes,value,option,edited});ctx.ui.notify('UI complete'); } }); }`);
 if (process.env.PI_TEST_PLAN_EXTENSION) fs.cpSync(process.env.PI_TEST_PLAN_EXTENSION, path.join(agent,'extensions/plan-mode'), {recursive:true});
 let scenario: 'allow' | 'deny' | 'mcp' | 'agent' | 'queue' = 'allow'; let scenarioStart = 0;
 let releaseQueue: (()=>void) | undefined;
 const requests:any[]=[];
 server=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);requests.push(body);
  if (scenario === 'queue' && requests.length === scenarioStart + 1) await new Promise<void>(resolve=>{releaseQueue=resolve;});
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  const send=(delta:any,finish:any=null)=>res.write('data: '+JSON.stringify({id:'test',object:'chat.completion.chunk',created:1,model:'desktop-test',choices:[{index:0,delta,finish_reason:finish}]})+'\n\n');
  if(scenario==='mcp' && requests.length===scenarioStart+1){const tool=body.tools?.find((t:any)=>t.function.name.startsWith('mcp_test_'));send({role:'assistant',tool_calls:[{index:0,id:'call_mcp',type:'function',function:{name:tool?.function.name||'MISSING_MCP',arguments:JSON.stringify({text:'from mcp'})}}]});send({},'tool_calls');}
  else if(scenario==='deny' && requests.length===scenarioStart+1){send({role:'assistant',tool_calls:[{index:0,id:'call_deny',type:'function',function:{name:'write',arguments:JSON.stringify({path:'denied.txt',content:'must not exist'})}}]});send({},'tool_calls');}
  else if(requests.length===1){send({role:'assistant',tool_calls:[{index:0,id:'call_read',type:'function',function:{name:'read',arguments:JSON.stringify({path:'example.txt'})}}]});send({},'tool_calls');}
  else if(requests.length===2){send({role:'assistant',tool_calls:[{index:0,id:'call_write',type:'function',function:{name:'write',arguments:JSON.stringify({path:'result.txt',content:'verified'})}}]});send({},'tool_calls');}
  else {send({role:'assistant',content:'Local test completed.'});send({},'stop');}
  res.end('data: [DONE]\n\n');
 });
 await new Promise<void>(r=>server!.listen(0,'127.0.0.1',r));const port=(server.address() as any).port;
 fs.writeFileSync(path.join(agent,'models.json'),JSON.stringify({providers:{'desktop-local-test':{baseUrl:`http://127.0.0.1:${port}/v1`,api:'openai-completions',apiKey:'not-a-secret',models:[{id:'desktop-test',name:'Local Test',reasoning:true,input:['text','image'],contextWindow:32000,maxTokens:1000}]}}}));
 fs.writeFileSync(path.join(agent,'mcp.json'),JSON.stringify({mcpServers:{test:{command:process.execPath,args:[path.resolve('tests/fixtures/fake-mcp.cjs')]}}}));
 const env=discoverPi(real==='bundled'?{runtime:'bundled',agentDir:agent}:{executable:real,agentDir:agent},real==='bundled'?{PATH:''}:{PATH:process.env.PATH},process.env.PI_TEST_RUNTIME_DIR);expect(env.supported).toBe(true);
 const index=new SessionIndex([path.join(agent,'sessions')],owned);const events:PiEvent[]=[];
 const backend=new PiBackend(env,index,owned,process.env.PI_TEST_POLICY || path.resolve('extensions/desktop-policy/index.mjs'),e=>{
  events.push(e);
  if(e.type==='ui'&&e.request.title!=='wait'&&['confirm','input','select','editor'].includes(e.request.method))queueMicrotask(()=>backend.respond(e.key,e.generation,{id:e.request.id,...(e.request.method==='confirm'?{confirmed:scenario!=='deny'}:{value:e.request.method==='select'?'A':'answer'})}));
 });backends.push(backend);
 const run=await backend.connect({cwd:project,trustProject:false,permission:'ask'});
 expect(run.commands.some(c=>c.name==='desktop-ui-test')).toBe(true);
 if (process.env.PI_TEST_PLAN_EXTENSION) {
  expect(run.commands.some(c=>c.name==='plan')).toBe(true);
  await backend.prompt(run.key,'/plan','followUp');
  expect(events.some(e=>e.type==='ui' && e.request.method==='setStatus' && e.request.statusKey==='plan-mode')).toBe(true);
  await backend.prompt(run.key,'/todos','followUp');
  await backend.prompt(run.key,'/plan','followUp');
 }
 await backend.prompt(run.key,'/desktop-ui-test','followUp');
 expect(events.filter(e=>e.type==='ui').length).toBeGreaterThanOrEqual(6);
 await backend.model(run.key,'desktop-local-test','desktop-test');
 expect(backend.runs().find(r=>r.key===run.key)?.thinkingLevels).toContain('high');
 await backend.thinking(run.key,'high');
 expect(backend.runs().find(r=>r.key===run.key)?.thinkingLevel).toBe('high');
 await backend.prompt(run.key,'Read example.txt and create result.txt.','followUp',[{type:'image',mimeType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg=='}]);
 await vi.waitFor(()=>expect(events.some(e=>e.type==='rpc'&&e.event.type==='agent_settled')).toBe(true),{timeout:20000,interval:100});
 expect(JSON.stringify(requests[0].messages)).toContain('data:image/png;base64,');
 expect(requests).toHaveLength(3);expect(requests[1].messages.some((m:any)=>m.role==='tool'&&m.content.includes('original'))).toBe(true);
 expect(fs.readFileSync(path.join(project,'result.txt'),'utf8')).toBe('verified');
 expect(events.some(e=>e.type==='ui'&&e.request.method==='confirm'&&String(e.request.title).includes('write'))).toBe(true);

 scenario='queue'; scenarioStart=requests.length;
 await backend.prompt(run.key,'First slow question','followUp');
 await vi.waitFor(()=>expect(releaseQueue).toBeTypeOf('function'));
 await backend.prompt(run.key,'Follow-up number one','followUp');
 await backend.prompt(run.key,'Follow-up number two','followUp');
 await vi.waitFor(()=>expect(backend.runs().find(r=>r.key===run.key)?.queue?.map(q=>q.text)).toEqual(['Follow-up number one','Follow-up number two']));
 expect(backend.runs().find(r=>r.key===run.key)?.pending).toBe(2);
 releaseQueue!();
 await vi.waitFor(()=>expect(backend.runs().find(r=>r.key===run.key)?.status).toBe('idle'),{timeout:10000});
 expect(backend.runs().find(r=>r.key===run.key)?.pending).toBe(0);
 expect(JSON.stringify(requests.at(-1).messages)).toContain('Follow-up number two');
 scenario='deny'; scenarioStart=requests.length;
 const settled=events.filter(e=>e.type==='rpc'&&e.event.type==='agent_settled').length;
 await backend.prompt(run.key,'Do not approve the next write.','followUp');
 await vi.waitFor(()=>expect(events.filter(e=>e.type==='rpc'&&e.event.type==='agent_settled').length).toBeGreaterThan(settled),{timeout:10000});
 expect(fs.existsSync(path.join(project,'denied.txt'))).toBe(false);
 expect(requests.at(-1).messages.some((m:any)=>m.role==='tool'&&m.content.includes('用户拒绝'))).toBe(true);
 scenario='mcp';scenarioStart=requests.length;
 const mcpSettled=events.filter(e=>e.type==='rpc'&&e.event.type==='agent_settled').length;
 await backend.prompt(run.key,'Call the MCP echo tool.','followUp');
 await vi.waitFor(()=>expect(events.filter(e=>e.type==='rpc'&&e.event.type==='agent_settled').length).toBeGreaterThan(mcpSettled),{timeout:10000});
 expect(requests.at(-1).messages.some((m:any)=>m.role==='tool'&&m.content.includes('from mcp'))).toBe(true);
 expect(events.some(e=>e.type==='ui'&&String(e.request.title).includes('mcp_test_'))).toBe(true);
 const waiting=backend.prompt(run.key,'/desktop-wait','followUp');
 await vi.waitFor(()=>expect(events.some(e=>e.type==='ui'&&e.request.title==='wait')).toBe(true));
 await backend.stop(run.key);await waiting;
 expect(index.history(run.key).entries.some(e=>e.type==='custom'&&e.customType==='desktop-cancel'&&!(e.data as any)?.answer)).toBe(true);
 const renewed=await backend.refresh(run.key);expect(renewed.generation).not.toBe(run.generation);expect(renewed.file).toBe(run.file);
 expect(renewed.commands.some(c=>c.name==='desktop-ui-test')).toBe(true);
 expect(index.scan()).toHaveLength(1);expect(index.history(run.key).entries.some(e=>e.type==='custom')).toBe(true);
 scenario='agent';
 const child=await backend.connect({cwd:project,trustProject:false,permission:'ask',systemPrompt:'YOU ARE DESKTOP RESEARCH',tools:['read']});
 await backend.model(child.key,'desktop-local-test','desktop-test');
 await backend.prompt(child.key,'Summarize without tools.','followUp');
 await vi.waitFor(()=>expect(events.some(e=>e.type==='rpc'&&e.key===child.key&&e.event.type==='agent_settled')).toBe(true),{timeout:10000});
 expect(requests.at(-1).messages.some((m:any)=>['system','developer'].includes(m.role)&&m.content.includes('YOU ARE DESKTOP RESEARCH'))).toBe(true);
 expect(requests.at(-1).tools.map((t:any)=>t.function.name)).toEqual(['read']);

 for (const mode of ['plan', 'autoEdit', 'fullAccess'] as const) {
  const changed=await backend.setAccessMode(run.key,mode);
  expect(changed.accessMode).toBe(mode);
  scenario='deny'; scenarioStart=requests.length;
  const before=events.filter(e=>e.type==='rpc'&&e.key===run.key&&e.event.type==='agent_settled').length;
  const approvals=events.filter(e=>e.type==='ui'&&e.request.method==='confirm').length;
  fs.rmSync(path.join(project,'denied.txt'),{force:true});
  await backend.prompt(run.key,'Process the next tool request.','followUp');
  await vi.waitFor(()=>expect(events.filter(e=>e.type==='rpc'&&e.key===run.key&&e.event.type==='agent_settled').length).toBeGreaterThan(before),{timeout:10000});
  expect(fs.existsSync(path.join(project,'denied.txt'))).toBe(mode!=='plan');
  expect(events.filter(e=>e.type==='ui'&&e.request.method==='confirm')).toHaveLength(approvals);
  if(mode==='plan') {
   // Runtime mode changes now use the policy control file, retaining the tool
   // registry. The denied write above verifies enforcement without a restart.
   expect(requests[scenarioStart].tools.map((t:any)=>t.function.name)).toContain('read');
   expect(backend.runs().find(r=>r.key===run.key)?.planReady).toBe(true);
  }
 }
},40000);
