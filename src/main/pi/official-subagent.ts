import fs from 'node:fs';
import path from 'node:path';
import {discoverPi} from './environment';
/** Disk status is separate from whether a running session has loaded the extension. */
export function officialSubagentStatus(agentDir:string) {
 const file=path.join(agentDir,'extensions','desktop-official-subagent','index.ts');
 const scout=path.join(agentDir,'agents','desktop-scout.md');
 return {installed:fs.existsSync(file)&&fs.readFileSync(file,'utf8').startsWith('// PI Desktop official-subagent adapter v1'),scoutExists:fs.existsSync(scout),path:file};
}
/** Explicit opt-in, never silently replaces an existing subagent plugin or agent. */
export function enableOfficialSubagent(agentDir:string) {
 const runtime=discoverPi({runtime:'bundled',agentDir});
 if(!runtime.launchArgs?.[0])throw new Error('内置 pi 运行时缺失，请先修复内核。');
 const source=path.resolve(path.dirname(runtime.launchArgs[0]),'../../examples/extensions/subagent/index.ts');
 if(!fs.existsSync(source))throw new Error('内置 pi 官方 subagent 示例缺失');
 const root=path.join(agentDir,'extensions','desktop-official-subagent'),file=path.join(root,'index.ts');
 const marker='// PI Desktop official-subagent adapter v1';
 if(fs.existsSync(file)&&!fs.readFileSync(file,'utf8').startsWith(marker))throw new Error('目标扩展已存在，未覆盖。');
 const settings=fs.existsSync(path.join(agentDir,'settings.json'))?JSON.parse(fs.readFileSync(path.join(agentDir,'settings.json'),'utf8')):{};
 if((settings.packages??[]).some((p:any)=>/subagents?/i.test(typeof p==='string'?p:p?.source??'')))throw new Error('已配置其他 subagent 插件，请先在扩展管理中停用它，避免同名工具冲突。');
 const extensions=path.join(agentDir,'extensions');
 if(fs.existsSync(extensions)&&fs.readdirSync(extensions).some(name=>name!=='desktop-official-subagent'&&/subagents?/i.test(name)))throw new Error('已发现其他 subagent 扩展，未重复安装。');
 fs.mkdirSync(root,{recursive:true});
 const code=`${marker}
import official from ${JSON.stringify(source)};
import fs from 'node:fs';
export default function(pi:any) {
 official({...pi,registerTool(tool:any){
  pi.registerTool({...tool, async execute(...args:any[]){
   let mode=process.env.PI_DESKTOP_PERMISSION;
   try {if(process.env.PI_DESKTOP_MODE_FILE)mode=fs.readFileSync(process.env.PI_DESKTOP_MODE_FILE,'utf8').trim();}catch{}
   if(mode&&mode!=='fullAccess')throw new Error('官方 subagent 插件的子进程不支持 Desktop 独立审批。请使用完全访问模式，或使用设置中的独立会话。');
   const controller=new AbortController();
   const parent=args[2];
   args[2]=parent?AbortSignal.any([parent,controller.signal]):controller.signal;
   const timer=setInterval(()=>{try{if(process.env.PI_DESKTOP_MODE_FILE&&fs.readFileSync(process.env.PI_DESKTOP_MODE_FILE,'utf8').trim()!=='fullAccess')controller.abort();}catch{controller.abort();}},250);
   try{return await tool.execute(...args);}finally{clearInterval(timer);}

  }});
 }});
}
`;
 fs.writeFileSync(file,code,{mode:0o600});
 const agentRoot=path.join(agentDir,'agents');fs.mkdirSync(agentRoot,{recursive:true});
 const scout=path.join(agentRoot,'desktop-scout.md');
 if(!fs.existsSync(scout))fs.writeFileSync(scout,'---\nname: desktop-scout\ndescription: 只读检查项目并汇总发现\ntools: read, grep, find, ls\n---\n你是只读研究助手。检查任务涉及的代码，报告结论、证据和不确定性。不要修改文件。\n',{mode:0o600});
 return {path:file};
}
