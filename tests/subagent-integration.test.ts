import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';
import {it,expect,vi} from 'vitest';
import {enableOfficialSubagent,officialSubagentStatus} from '../src/main/pi/official-subagent';
import {PiBackend} from '../src/main/pi/backend';import {SessionIndex} from '../src/main/pi/session-index';import {discoverPi} from '../src/main/pi/environment';
import {historyToMessages} from '../src/renderer/pi/adapter';import {projectSubagents} from '../src/renderer/pi/subagents';
it('runs the official plugin via bundled pi and restores child transcript from persisted parent history',async()=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'pi-subagent-integration-'))),agent=path.join(root,'agent'),project=path.join(root,'project'),owned=path.join(agent,'sessions/desktop');
 fs.mkdirSync(project);fs.mkdirSync(agent);
 expect(officialSubagentStatus(agent)).toMatchObject({installed:false,scoutExists:false});
 enableOfficialSubagent(agent);
 expect(officialSubagentStatus(agent)).toMatchObject({installed:true,scoutExists:true});
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
  expect(children[0]).toMatchObject({agent:'desktop-scout',status:'completed'});
  expect(JSON.stringify(children[0].messages)).toContain('hello from local test');
  expect(requests).toBeGreaterThanOrEqual(3);
 }finally{backend.dispose();index.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));fs.rmSync(root,{recursive:true,force:true});}
},45000);
