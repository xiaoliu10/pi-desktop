import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';
import { expect, it, vi } from 'vitest';
import { AutomationService } from '../src/main/pi/automation-service';
import { PiBackend } from '../src/main/pi/backend';import { SessionIndex } from '../src/main/pi/session-index';import { discoverPi } from '../src/main/pi/environment';
it.skipIf(!process.env.PI_TEST_EXECUTABLE)('executes saved workflow with real pi, keeps session history, and cancels a waiting approval',async()=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'pi-auto-real-')));const agent=path.join(root,'agent'),owned=path.join(agent,'sessions/desktop');fs.mkdirSync(agent,{recursive:true});let waiting=false;
 const requests:any[]=[];
 const server=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);requests.push(body);res.writeHead(200,{'Content-Type':'text/event-stream'});
 const send=(delta:any,reason:string|null=null)=>res.write('data: '+JSON.stringify({id:'auto-test',object:'chat.completion.chunk',created:1,model:'auto-test',choices:[{index:0,delta,finish_reason:reason}]})+'\n\n');
 if(waiting&&!body.messages.some((m:any)=>m.role==='tool')){send({role:'assistant',tool_calls:[{index:0,id:'write-1',type:'function',function:{name:'write',arguments:JSON.stringify({path:'never.txt',content:'blocked'})}}]});send({},'tool_calls');}
 else{send({role:'assistant',content:'Workflow step completed.'});send({},'stop');}res.end('data: [DONE]\n\n');});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as any).port;
 fs.writeFileSync(path.join(agent,'models.json'),JSON.stringify({providers:{'auto-local':{baseUrl:`http://127.0.0.1:${port}/v1`,api:'openai-completions',apiKey:'test-local',models:[{id:'auto-test',name:'Automation test',input:['text'],contextWindow:32000,maxTokens:1000}]}}}));
 const index=new SessionIndex([owned],owned);let automation:AutomationService|undefined;
 const backend=new PiBackend(discoverPi({executable:process.env.PI_TEST_EXECUTABLE,agentDir:agent},{PATH:process.env.PATH}),index,owned,path.resolve('extensions/desktop-policy/index.mjs'),event=>automation?.onPiEvent(event));
 automation=new AutomationService(path.join(root,'automations.json'),()=>backend);
 try{
  const workflow=automation.saveWorkflow({id:'',name:'Real workflow',description:'',whenToUse:'',scope:'project',cwd:root,parameters:[],steps:[{id:'1',name:'Inspect',prompt:'Inspect step without tools.'},{id:'2',name:'Summarize',prompt:'Summarize prior step without tools.'}],updatedAt:0});
  automation.runWorkflow({id:workflow.id,cwd:root,args:{},permission:'ask',model:'auto-local/auto-test'});
  await vi.waitFor(()=>expect(automation!.snapshot().runs[0].status).toBe('succeeded'),{timeout:15000});expect(requests).toHaveLength(2);
  expect(JSON.stringify(requests[1].messages)).toContain('Inspect step without tools');expect(JSON.stringify(requests[1].messages)).toContain('Summarize prior step');
  expect(index.scan()).toHaveLength(1);expect(index.history(automation.snapshot().runs[0].sessionKey!).branch.length).toBeGreaterThan(2);
  waiting=true;const run=automation.runWorkflow({id:workflow.id,cwd:root,args:{},permission:'ask',model:'auto-local/auto-test'});
  await vi.waitFor(()=>expect(automation!.snapshot().runs[0].status).toBe('waiting'),{timeout:10000});
  await automation.stop(run.id);await vi.waitFor(()=>expect(backend.runs()).toHaveLength(0));expect(automation.snapshot().runs[0].status).toBe('stopped');expect(fs.existsSync(path.join(root,'never.txt'))).toBe(false);
 }finally{automation.dispose();backend.dispose();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));fs.rmSync(root,{recursive:true,force:true});}
},25000);
