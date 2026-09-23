import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { McpClient } from './mcp-client.cjs';
import { resolveImports } from './mcp-imports.cjs';
export default async function desktopMcp(pi) {
  if (process.env.PI_DESKTOP_PERMISSION === 'plan') return;
  const clients=[]; const failures=[];
  pi.on('session_shutdown',()=>{for(const client of clients)client.close();});
  pi.on('session_start',(_e,ctx)=>{for(const name of failures)ctx.ui.notify(`MCP ${name} 未加载：请在设置页检测连接。`,'warning');ctx.ui.setStatus('desktop-mcp',clients.length?`MCP：${clients.length} 个连接`:undefined);});
  const roots=[process.env.PI_CODING_AGENT_DIR];if(process.env.PI_DESKTOP_TRUST_PROJECT==='1')roots.push(path.join(process.cwd(),'.pi'));
  const servers=new Map(); const source=new Map();
  for(const root of roots.filter(Boolean)){const file=path.join(root,'mcp.json');try{const cfg=JSON.parse(fs.readFileSync(file,'utf8'));for(const [name,config]of Object.entries(cfg.mcpServers||{}))servers.set(name,config);for(const e of resolveImports(cfg.imports))if(!servers.has(e.name)){servers.set(e.name,e.config);source.set(e.name,e.source);}}catch{if(fs.existsSync(file))failures.push('配置文件');}}
  await Promise.all([...servers].map(async([name,config])=>{
    if(config.disabled||config.enabled===false)return;
    const client=new McpClient(config,process.cwd());
    try{await client.connect();const tools=await client.tools();clients.push(client);
      for(const tool of tools){const id='mcp_'+name.replace(/[^a-zA-Z0-9_]/g,'_').slice(0,18)+'_'+createHash('sha256').update(name+':'+tool.name).digest('hex').slice(0,8)+'_'+tool.name.replace(/[^a-zA-Z0-9_]/g,'_').slice(0,24);
        pi.registerTool({name:id,label:`${name}${source.has(name)?' · '+source.get(name):''} / ${tool.name}`,description:String(tool.description||tool.name),parameters:tool.inputSchema||{type:'object',properties:{}},async execute(_id,args,signal){const result=await client.request('tools/call',{name:tool.name,arguments:args},signal);if(result.isError)throw new Error((result.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('\n')||'MCP tool failed');return{content:(result.content||[]).filter(c=>['text','image'].includes(c.type)),details:{server:name,tool:tool.name}};}});
      }
    }catch{client.close();failures.push(name);}
  }));
}
