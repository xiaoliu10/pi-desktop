import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {expect,it,vi} from 'vitest';
import {PiBackend} from '../src/main/pi/backend';
import {SessionIndex} from '../src/main/pi/session-index';
import {discoverPi} from '../src/main/pi/environment';
import {historyToMessages} from '../src/renderer/pi/adapter';
import {conversationPlan} from '../src/renderer/pi/conversation-plan';
it.skipIf(!process.env.PI_TEST_EXECUTABLE)('real pi plan mode exposes checklist tool and persists its results',async()=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'pi-plan-real-'))),agent=path.join(root,'agent'),owned=path.join(agent,'sessions/desktop');fs.mkdirSync(agent,{recursive:true});let complete=false,exposed=false;
 const server=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);exposed=body.tools.some((t:any)=>t.function?.name==='desktop_update_plan');res.writeHead(200,{'Content-Type':'text/event-stream'});const send=(delta:any,finish_reason:string|null=null)=>res.write('data: '+JSON.stringify({id:'plan-test',object:'chat.completion.chunk',created:1,model:'test',choices:[{index:0,delta,finish_reason}]})+'\n\n');
 if(!body.messages.some((m:any)=>m.role==='tool')){send({role:'assistant',tool_calls:[{index:0,id:'plan-1',type:'function',function:{name:'desktop_update_plan',arguments:JSON.stringify({plan:[{step:'Inspect project',status:'completed'}]})}}]});send({},'tool_calls');}else{send({role:'assistant',content:'Done'});send({},'stop');complete=true;}res.end('data: [DONE]\n\n');});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));fs.writeFileSync(path.join(agent,'models.json'),JSON.stringify({providers:{local:{baseUrl:`http://127.0.0.1:${(server.address() as any).port}/v1`,api:'openai-completions',apiKey:'test',models:[{id:'test',input:['text'],contextWindow:32000,maxTokens:1000}]}}}));
 const index=new SessionIndex([owned],owned);const backend=new PiBackend(discoverPi({executable:process.env.PI_TEST_EXECUTABLE,agentDir:agent},{PATH:process.env.PATH}),index,owned,path.resolve('extensions/desktop-policy/index.mjs'),()=>{});
 try{const run=await backend.connect({cwd:root,permission:'plan',trustProject:false,model:'local/test'});await backend.prompt(run.key,'Make a plan','followUp');await vi.waitFor(()=>expect(complete).toBe(true),{timeout:15000});expect(exposed).toBe(true);await vi.waitFor(()=>expect(conversationPlan(historyToMessages(index.history(run.key).branch))).toEqual([{step:'Inspect project',status:'completed'}]));}
 finally{backend.dispose();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));fs.rmSync(root,{recursive:true,force:true});}
},25000);
