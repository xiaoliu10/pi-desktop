#!/usr/bin/env node
import fs from 'node:fs';
const file = process.argv[process.argv.indexOf('--session') + 1];
if (process.argv.includes('--session') && !fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ type:'session',version:3,id:'fake',cwd:process.cwd(),timestamp:new Date().toISOString() })+'\n');
const send = obj => process.stdout.write(JSON.stringify(obj)+'\n');
let pendingUi, queue = {steering:[],followUp:[]};
let streaming = false;
let thinking = 'medium';
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; let i; while ((i = input.indexOf('\n')) >= 0) { const line = input.slice(0,i); input = input.slice(i+1); if(line) handle(JSON.parse(line)); } });
function handle(r) {
 const ok = data => send({type:'response',id:r.id,success:true,data});
 switch(r.type) {
 case 'get_state': send({type:'extension_ui_request',id:'policy',method:'setStatus',statusKey:'desktop-policy',statusText:'工具权限：逐次确认'}); return ok({isStreaming:streaming,thinkingLevel:thinking});
 case 'get_available_models': return ok({models:[{id:'fake-model',provider:'test',name:'Test model',apiKey:'DO NOT EXPOSE'}]});
 case 'get_commands': return ok({commands:[{name:'hello',source:'extension',path:'/tmp/test.mjs'}]});
 case 'set_model': return ok({});
 case 'set_thinking_level': thinking = r.level ?? thinking; return ok({});
 case 'get_available_thinking_levels': return ok({levels:['off','minimal','low','medium','high','xhigh','max']});
 case 'get_session_stats': return ok({tokens:{input:1000,output:200,cacheRead:1000,cacheWrite:1000,total:3200},cost:0.01,contextUsage:{tokens:1200,contextWindow:200000,percent:1}});
 case 'get_messages': return ok({messages:[{role:'system',content:'base prompt',timestamp:1,sections:{tools:'- read: file reader\n- bash: shell',skills:'Skill: demo'}},{role:'user',content:'hello',timestamp:2},{role:'assistant',content:[{type:'text',text:'hi'}],timestamp:3},{role:'system',content:'',timestamp:4,toolsAdded:[{name:'mcp_demo_search',description:'demo mcp tool',inputSchema:{type:'object'}},{name:'read',description:'built-in reader',inputSchema:{type:'object'}}]}]});
 case 'echo': return setTimeout(()=>ok(r.value), r.delay || 0);
 case 'never': return;
 case 'exit': return process.exit(7);
 case 'noise': process.stdout.write('plugin log\n'); return ok('fine');
 case 'unicode': { const data = Buffer.from(JSON.stringify({type:'response',id:r.id,success:true,data:'中文\u2028\u2029'})+'\n'); const pos=data.indexOf(Buffer.from('中'))+1; process.stdout.write(data.subarray(0,pos)); setTimeout(()=>process.stdout.write(data.subarray(pos)),5); return; }
 case 'prompt':
  if(r.message === '/crash') return process.exit(7);
  if(r.message === '/dialog') { pendingUi=r; send({type:'extension_ui_request',id:'dialog',method:'confirm',title:'Confirm?'}); return; }
  if(r.message === '/long') { ok({}); streaming=true; send({type:'agent_start'}); return; }
  if(r.message === '/endlong') { streaming=false; send({type:'agent_settled'}); return ok({}); }
  // 一次模型调用的结束边界：常用于验证挂起的模型/思考切换在此下发。
  if(r.message === '/boundary') { send({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'step done'}]}}); return ok({}); }
  if(streaming) {
   const kind = r.streamingBehavior === 'steer' ? 'steering' : 'followUp';
   queue[kind].push(r.message);
   send({type:'queue_update', steering:[...queue.steering], followUp:[...queue.followUp]});
   return ok({});
  }
  ok({}); send({type:'agent_start'}); send({type:'agent_end',willRetry:true});
  setTimeout(()=>send({type:'agent_settled'}), 80); return;
 case 'extension_ui_response': if(pendingUi) { send({type:'response',id:pendingUi.id,success:true}); pendingUi=null; } return;
 case 'fork': return ok({text:'forked text',cancelled:false});
 case 'clear_queue': { const old=queue; queue={steering:[],followUp:[]}; ok(old); send({type:'queue_update', steering:[], followUp:[]}); return; }
 case 'abort': send({type:'agent_settled'}); return ok({});
 default: return send({type:'response',id:r.id,success:false,error:'unsupported'});
 }
}
