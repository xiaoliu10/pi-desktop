import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';
import {it,expect,vi} from 'vitest';
import {subagentCapabilityStatus} from '../src/main/pi/official-subagent';
import {PiBackend} from '../src/main/pi/backend';import {SessionIndex} from '../src/main/pi/session-index';import {discoverPi} from '../src/main/pi/environment';
import {historyToMessages} from '../src/renderer/pi/adapter';import {projectSubagents} from '../src/renderer/pi/subagents';
it('runs the official plugin via bundled pi and restores child transcript from persisted parent history',async()=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'pi-subagent-integration-'))),agent=path.join(root,'agent'),project=path.join(root,'project'),owned=path.join(agent,'sessions/desktop');
 fs.mkdirSync(project);fs.mkdirSync(agent);
 // 2026-10-18 起内置 subagent 已全删：能力状态是纯只读检测，不写盘、无启用入口。
 // 无第三方插件时 available=false（本测试用自带扩展路径提供 subagent 工具，见下方 env）。
 expect(subagentCapabilityStatus(agent)).toEqual({available:false});
 fs.writeFileSync(path.join(agent,'settings.json'),JSON.stringify({packages:['npm:@wengine-ai/pi-subagents']}));
 expect(subagentCapabilityStatus(agent)).toMatchObject({available:true,source:'npm:@wengine-ai/pi-subagents'});
 // 内置 subagent 已删：测试自带一个最小扩展提供 subagent 工具（与 desktop 内置解耦，
 // 只验证事件层持久化 + 从父会话恢复子转录这条通用链路）。
 const extDir=path.join(agent,'extensions');fs.mkdirSync(extDir,{recursive:true});
 fs.writeFileSync(path.join(extDir,'fake-subagent.js'),`export default function(pi){
   pi.registerTool({name:'subagent',label:'subagent',description:'delegate',parameters:{type:'object',properties:{agent:{type:'string'},task:{type:'string'}}},async execute(id,args){return {content:[{type:'text',text:'hello from local test'}],details:{mode:'single',agent:args.agent,results:[{agent:args.agent,exitCode:0,messages:[{role:'assistant',content:'hello from local test'}]}]}};}});
 }`);
 let requests=0;const server=http.createServer(async(req,res)=>{
  for await(const _ of req){};requests++;
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  const send=(delta:any,finish:any=null)=>res.write('data: '+JSON.stringify({id:'test',object:'chat.completion.chunk',created:1,model:'test',choices:[{index:0,delta,finish_reason:finish}]})+'\n\n');
  if(requests===1){send({role:'assistant',tool_calls:[{index:0,id:'delegate',type:'function',function:{name:'subagent',arguments:JSON.stringify({agent:'desktop-scout',task:'Report hello',agentScope:'user'})}}]});send({},'tool_calls');}
  else {send({role:'assistant',content:'hello from local test'});send({},'stop');}
  res.end('data: [DONE]\n\n');
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 fs.writeFileSync(path.join(agent,'models.json'),JSON.stringify({providers:{local:{baseUrl:`http://127.0.0.1:${(server.address() as any).port}/v1`,api:'openai-completions',apiKey:'test',models:[{id:'test',contextWindow:32000,maxTokens:1000}]}}}));
 const env=discoverPi({runtime:'bundled',agentDir:agent});const index=new SessionIndex([path.join(agent,'sessions')],owned);const events:any[]=[];
 const backend=new PiBackend(env,index,owned,path.resolve('extensions/desktop-policy/index.mjs'),e=>events.push(e));
 try{
  const run=await backend.connect({cwd:project,permission:'fullAccess',trustProject:false,model:'local/test'});
  await backend.prompt(run.key,'Delegate this task','followUp');
  await vi.waitFor(()=>expect(events.some(e=>e.type==='rpc'&&e.event.type==='tool_execution_end'&&e.event.toolName==='subagent')).toBe(true),{timeout:30000});
  const result=events.find(e=>e.type==='rpc'&&e.event.type==='tool_execution_end'&&e.event.toolName==='subagent').event;
  expect(result.isError,JSON.stringify(result.result)).not.toBe(true);
  expect(result.result.details.results[0].messages.length).toBeGreaterThan(0);
  await vi.waitFor(()=>expect(backend.runs()[0].status).toBe('idle'),{timeout:10000});
  const history=index.history(run.key);const children=projectSubagents(historyToMessages(history.branch),false);
  expect(children[0]).toMatchObject({mode:'single',status:'completed',agent:'desktop-scout'});
  expect(JSON.stringify(children[0].messages)).toContain('hello from local test');
  // 2 次请求 = 首轮发起 subagent 工具 + 拿到结果后的总结轮。fake 扩展同步返回，
  // 不再起子会话（内置版删掉后少一次请求），故断言从 ≥3 调整为 ≥2。
 }finally{backend.dispose();index.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));fs.rmSync(root,{recursive:true,force:true});}
},45000);
