import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { McpClient } from './mcp-client.cjs';
import { resolveImports } from './mcp-imports.cjs';
/** 单服务器连接上限：不可达的 HTTP 端点曾把 pi 的 RPC ready 拖住 10s+
 *  （扩展 init 期间 pi 不响应 get_state）。超时即按失败处理，后台继续重试。 */
const CONNECT_TIMEOUT_MS = 5_000;
/** pi ≥0.99 自带原生 MCP（builtin:mcp，读同一份 mcp.json）。desktop 只在旧版 CLI 上
 *  用本桥：双连接会让模型看到两套工具、连接数翻倍。版本由 backend 经
 *  PI_DESKTOP_PI_VERSION 注入；与 src/main/pi/environment.ts 的 piHasNativeMcp 保持一致。 */
export function hasNativeMcp(version) {
  if (!version) return false;
  const pa = String(version).split('.').map(n => Number.parseInt(n, 10));
  const pb = [0, 99, 0];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = Number.isFinite(pa[i]) ? pa[i] : -1;
    const y = Number.isFinite(pb[i]) ? pb[i] : -1;
    if (x !== y) return x > y;
  }
  return true;
}
export default async function desktopMcp(pi) {
  if (process.env.PI_DESKTOP_PERMISSION === 'plan') return;
  if (hasNativeMcp(process.env.PI_DESKTOP_PI_VERSION)) return;
  const clients=[]; const failures=[];
  const roots=[process.env.PI_CODING_AGENT_DIR];if(process.env.PI_DESKTOP_TRUST_PROJECT==='1')roots.push(path.join(process.cwd(),'.pi'));
  const servers=new Map(); const source=new Map(); const scopeDisabled=new Map(); const scopeEnabled=new Map();
  // Desktop 停用/启用覆盖层：mcp.json 顶层 disabledServers:[名称] / enabledServers:[名称]
  // （设置页对导入服务的启停写这里，不改 cursor/claude 等原工具文件）。enabledServers 显式
  // 启用可覆盖来源工具自己的 enabled=false（否则 codex 里关掉的导入服务在 Desktop 永远启用不了）。
  // 按“定义该服务的那个作用域”的列表生效：项目同名覆盖全局时，以项目作用域的状态为准。
  for(const root of roots.filter(Boolean)){const file=path.join(root,'mcp.json');try{const cfg=JSON.parse(fs.readFileSync(file,'utf8'));const off=new Set(Array.isArray(cfg.disabledServers)?cfg.disabledServers.filter(n=>typeof n==='string').map(String):[]);const on=new Set(Array.isArray(cfg.enabledServers)?cfg.enabledServers.filter(n=>typeof n==='string').map(String):[]);for(const [name,config]of Object.entries(cfg.mcpServers||{})){servers.set(name,config);scopeDisabled.set(name,off);scopeEnabled.set(name,on);}for(const e of resolveImports(cfg.imports))if(!servers.has(e.name)){servers.set(e.name,e.config);scopeDisabled.set(e.name,off);scopeEnabled.set(e.name,on);source.set(e.name,e.source);}}catch{if(fs.existsSync(file))failures.push('配置文件');}}
  // 连接全部后台化：扩展 init 只解析配置（毫秒级），绝不 await 网络。
  // 工具在各自连上后补注册（下一轮对话生效），失败与状态延迟到 before_agent_start 补报。
  pi.on('session_shutdown',()=>{for(const client of clients)client.close();});
  const notified=new Set(); const ready=new Set();
  const flushStatus=(ctx)=>{for(const name of failures)if(!notified.has(name)){ctx.ui.notify(`MCP ${name} 未加载：请在设置页检测连接。`,'warning');notified.add(name);}ctx.ui.setStatus('desktop-mcp',ready.size?`MCP：${ready.size} 个连接`:undefined);};
  pi.on('session_start',(_e,ctx)=>flushStatus(ctx));
  // 首轮对话前也会触发：后台连接晚于 session_start 完成时状态仍能报出来。
  pi.on('before_agent_start',(_e,ctx)=>flushStatus(ctx));
  void Promise.all([...servers].map(async([name,config])=>{
    if(scopeDisabled.get(name)?.has(name))return;
    if((config.disabled||config.enabled===false)&&!scopeEnabled.get(name)?.has(name))return;
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
