import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { McpClient } from './mcp-client.cjs';
import { resolveImports } from './mcp-imports.cjs';
/** 单服务器连接上限：不可达的 HTTP 端点曾把 pi 的 RPC ready 拖住 10s+
 *  （扩展 init 期间 pi 不响应 get_state）。超时即按失败处理，后台继续重试。 */
const CONNECT_TIMEOUT_MS = 5_000;
export default async function desktopMcp(pi) {
  if (process.env.PI_DESKTOP_PERMISSION === 'plan') return;
  const clients=[]; const failures=[];
  const roots=[process.env.PI_CODING_AGENT_DIR];if(process.env.PI_DESKTOP_TRUST_PROJECT==='1')roots.push(path.join(process.cwd(),'.pi'));
  const servers=new Map(); const source=new Map();
  for(const root of roots.filter(Boolean)){const file=path.join(root,'mcp.json');try{const cfg=JSON.parse(fs.readFileSync(file,'utf8'));for(const [name,config]of Object.entries(cfg.mcpServers||{}))servers.set(name,config);for(const e of resolveImports(cfg.imports))if(!servers.has(e.name)){servers.set(e.name,e.config);source.set(e.name,e.source);}}catch{if(fs.existsSync(file))failures.push('配置文件');}}
  // 连接全部后台化：扩展 init 只解析配置（毫秒级），绝不 await 网络。
  // 工具在各自连上后补注册（下一轮对话生效），失败与状态延迟到 before_agent_start 补报。
  pi.on('session_shutdown',()=>{for(const client of clients)client.close();});
  const notified=new Set(); const ready=new Set();
  const flushStatus=(ctx)=>{for(const name of failures)if(!notified.has(name)){ctx.ui.notify(`MCP ${name} 未加载：请在设置页检测连接。`,'warning');notified.add(name);}ctx.ui.setStatus('desktop-mcp',ready.size?`MCP：${ready.size} 个连接`:undefined);};
  pi.on('session_start',(_e,ctx)=>flushStatus(ctx));
  // 首轮对话前也会触发：后台连接晚于 session_start 完成时状态仍能报出来。
  pi.on('before_agent_start',(_e,ctx)=>flushStatus(ctx));
  void Promise.all([...servers].map(async([name,config])=>{
    if(config.disabled||config.enabled===false)return;
    const client=new McpClient(config,process.cwd());
    try{
      await Promise.race([
        client.connect().then(async c=>{const tools=await c.tools();return tools;}),
        new Promise((_,reject)=>setTimeout(()=>reject(new Error('MCP 连接超时')),CONNECT_TIMEOUT_MS)),
      ]).then(async (tools)=>{
        clients.push(client); ready.add(name);
        for(const tool of tools){const id='mcp_'+name.replace(/[^a-zA-Z0-9_]/g,'_').slice(0,18)+'_'+createHash('sha256').update(name+':'+tool.name).digest('hex').slice(0,8)+'_'+tool.name.replace(/[^a-zA-Z0-9_]/g,'_').slice(0,24);
          pi.registerTool({name:id,label:`${name}${source.has(name)?' · '+source.get(name):''} / ${tool.name}`,description:String(tool.description||tool.name),parameters:tool.inputSchema||{type:'object',properties:{}},async execute(_id,args,signal){const result=await client.request('tools/call',{name:tool.name,arguments:args},signal);if(result.isError)throw new Error((result.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('\n')||'MCP tool failed');return{content:(result.content||[]).filter(c=>['text','image'].includes(c.type)),details:{server:name,tool:tool.name}};}});
        }
      });
    }catch{client.close();if(!ready.has(name))failures.push(name);}
  }));
}
