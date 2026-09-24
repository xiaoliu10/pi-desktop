import type { ProjectUpdate } from '../../shared/projects';
import { isAccessMode, type AccessMode } from '../../shared/access-mode';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { PiHost } from './host';
import { canonical, fileKey } from './session-index';
import { ARCHIVE_RETENTION_DAYS, DEFAULT_ARCHIVE_RETENTION_DAYS, DEFAULT_SHORTCUTS, validShortcut, type DesktopPreferences, type EditableResource, type ResourceDocument, type ResourceKind, type SettingsSnapshot, type McpServerRow } from '../../shared/settings';
const hash = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const revision = (p: string) => fs.existsSync(p) ? hash(fs.readFileSync(p)) : 'missing';
const object = (v: any) => v && typeof v === 'object' && !Array.isArray(v);
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
function readJson(file: string): any { if (!fs.existsSync(file)) return {}; let value:any;try{value=JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw new Error(`${path.basename(file)} 无法解析 JSON，请修复原配置文件`);}if(!object(value))throw new Error(`${path.basename(file)} 必须是 JSON 对象`);return value; }
function safePath(file: string) { let p=path.resolve(file);for(;;){if(fs.existsSync(p)&&fs.lstatSync(p).isSymbolicLink())throw new Error('不支持写入符号链接，请直接管理真实文件');const next=path.dirname(p);if(next===p)break;p=next;} }
function atomic(file: string, text: string, expected?: string) {
  if (Buffer.byteLength(text)>512*1024) throw new Error('编辑内容不能超过 512 KiB');
  safePath(file); if(expected!==undefined&&revision(file)!==expected)throw new Error('文件已被其他程序修改，请刷新后再保存');
  fs.mkdirSync(path.dirname(file),{recursive:true});
  if(fs.existsSync(file))fs.copyFileSync(file,`${file}.desktop-backup-${Date.now()}-${randomUUID().slice(0,6)}`,fs.constants.COPYFILE_EXCL);
  const tmp=`${file}.${randomUUID()}.tmp`;try{fs.writeFileSync(tmp,text,{mode:0o600,flag:'wx'});fs.renameSync(tmp,file);}finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
}
function mergeJson(file: string, change: (value:any)=>void, expected?:string) { const current=revision(file);if(expected!==undefined&&current!==expected)throw new Error('配置已变化，请刷新后重试');const value=readJson(file);change(value);atomic(file,JSON.stringify(value,null,2)+'\n',current); }
function walk(root:string, depth=0):string[]{if(depth>5)return[];try{return fs.readdirSync(root,{withFileTypes:true}).flatMap(e=>{if(e.isSymbolicLink()||e.name.startsWith('.')||e.name==='node_modules')return[];const p=path.join(root,e.name);return e.isDirectory()?walk(p,depth+1):[p];});}catch{return[];}}
export class SettingsService {
  constructor(private host: PiHost, private dataDir: string, private policyDir: string) {}
  private get preferencesFile(){return path.join(this.dataDir,'desktop-preferences.json');}
  preferences():DesktopPreferences { const p=readJson(this.preferencesFile);return{behavior:p.behavior==='steer'?'steer':'followUp',permission:isAccessMode(p.permission)?p.permission:'ask',shortcuts:{...DEFAULT_SHORTCUTS,...p.shortcuts},projects:Array.isArray(p.projects)?p.projects:[],hiddenProjects:Array.isArray(p.hiddenProjects)?p.hiddenProjects:[],sessionRenames:p.sessionRenames&&typeof p.sessionRenames==='object'&&!Array.isArray(p.sessionRenames)?Object.fromEntries(Object.entries(p.sessionRenames as Record<string,unknown>).filter(([,v])=>typeof v==='string'&&String(v).trim()).slice(0,500)) as Record<string,string>:{},autoArchive:p.autoArchive===true,archiveRetentionDays:(ARCHIVE_RETENTION_DAYS as readonly number[]).includes(p.archiveRetentionDays)?p.archiveRetentionDays:DEFAULT_ARCHIVE_RETENTION_DAYS,defaultThinkingLevel:THINKING_LEVELS.includes(p.defaultThinkingLevel)?p.defaultThinkingLevel:'off',sessionAccessModes:p.sessionAccessModes&&typeof p.sessionAccessModes==='object'&&!Array.isArray(p.sessionAccessModes)?Object.fromEntries(Object.entries(p.sessionAccessModes as Record<string,unknown>).filter(([,v])=>isAccessMode(v as string)).slice(0,500)) as Record<string,AccessMode>:{} }; }
  savePreferences(patch: Partial<DesktopPreferences>) {
    if(!object(patch)||Object.keys(patch).some(k=>!['behavior','permission','shortcuts','sessionRenames','sessionAccessModes','autoArchive','archiveRetentionDays','defaultThinkingLevel','openWithApp','memoryAssist','subagentDismissed'].includes(k)))throw new Error('不支持的设置项');
    if(patch.openWithApp!==undefined&&!(typeof patch.openWithApp==='string'&&/^[a-z0-9-]{1,40}$/.test(patch.openWithApp)))throw new Error('无效的外部应用偏好');
    if(patch.memoryAssist!==undefined&&typeof patch.memoryAssist!=='boolean')throw new Error('无效的记忆开关');
    if(patch.subagentDismissed!==undefined){const m=patch.subagentDismissed;if(typeof m!=='object'||!m||Array.isArray(m)||Object.values(m).some(v=>!Array.isArray(v)||v.some(x=>typeof x!=='string')))throw new Error('无效的子代理清理记录');}
    if(patch.sessionAccessModes!==undefined){if(!object(patch.sessionAccessModes)||Object.values(patch.sessionAccessModes).some(v=>!isAccessMode(v)))throw new Error('会话访问模式无效');}
    if(patch.autoArchive!==undefined&&typeof patch.autoArchive!=='boolean')throw new Error('无效的自动归档开关');
    if(patch.archiveRetentionDays!==undefined&&!(ARCHIVE_RETENTION_DAYS as readonly number[]).includes(patch.archiveRetentionDays))throw new Error('无效的归档保留时长');
    if(patch.defaultThinkingLevel!==undefined&&!THINKING_LEVELS.includes(patch.defaultThinkingLevel))throw new Error('无效思考等级');
    if(patch.sessionRenames!==undefined){if(!object(patch.sessionRenames)||Object.values(patch.sessionRenames).some(v=>typeof v!=='string'||v.length>200))throw new Error('重命名无效');}
    if(patch.behavior!==undefined&&!['steer','followUp'].includes(patch.behavior))throw new Error('无效输入策略');
    if(patch.permission!==undefined&&!isAccessMode(patch.permission))throw new Error('无效权限');
    if(patch.shortcuts){if(!object(patch.shortcuts)||Object.keys(patch.shortcuts).some(k=>!(k in DEFAULT_SHORTCUTS)))throw new Error('无效快捷键动作');const values=Object.values({...this.preferences().shortcuts,...patch.shortcuts});if(values.some(v=>typeof v!=='string'||!validShortcut(v)))throw new Error('快捷键格式：Mod+Shift+K（Shift、Alt 可选）');if(new Set(values.map(v=>v.toLowerCase())).size!==values.length)throw new Error('快捷键存在冲突');}
    mergeJson(this.preferencesFile,p=>Object.assign(p,patch));
  }
  private cwd(cwd?:string):string|undefined { if(!cwd)return undefined;if(!path.isAbsolute(cwd))throw new Error('项目路径必须是绝对路径');const p=canonical(cwd);const known=[...this.preferences().projects.map(p=>p.path),...this.host.index.scan().map(s=>s.cwd),...this.host.backend.runs().map(r=>r.cwd)];if(!known.some(x=>canonical(x)===p))throw new Error('请先添加项目或选择其会话');return p; }
  private roots(cwd?:string){const project=this.cwd(cwd);return[{root:this.host.environment.agentDir,scope:'user' as const},...(project?[{root:path.join(project,'.pi'),scope:'project' as const}]:[])];}
  private settingsPath(){return path.join(this.host.environment.agentDir,'settings.json');}
  /** pi 会话进程（模型切换/退出时）会整包写回 settings.json 的内存旧副本，可能丢掉
   * packages 注册（记忆插件重启后被「排除」的根因）。以 pi-desktop.json 记录的期望
   * 注册列表为准：缺失即补回，并在诊断里说明；包已从 npm 依赖移除的（pi remove）不恢复。 */
  private repairPackages(diagnostics: string[]): void {
    try {
      const desired = (readJson(path.join(this.dataDir, 'pi-desktop.json')).piPackages as unknown[] ?? []).filter((v): v is string => typeof v === 'string' && v.length <= 300);
      if (!desired.length) return;
      let npmDeps: Set<string> | null = null;
      try { const deps = readJson(path.join(this.host.environment.agentDir, 'npm', 'package.json')).dependencies ?? {}; npmDeps = new Set(Object.keys(deps).map(n => `npm:${n}`)); } catch { npmDeps = null; }
      const wanted = npmDeps ? desired.filter(spec => !spec.startsWith('npm:') || npmDeps!.has(spec)) : desired;
      if (!wanted.length) return;
      const current = readJson(this.settingsPath()).packages;
      const existing: string[] = Array.isArray(current) ? current.map((raw: unknown) => typeof raw === 'string' ? raw : typeof raw === 'object' && raw ? String((raw as any).source ?? '') : '').filter(Boolean) : [];
      const missing = wanted.filter(spec => !existing.includes(spec));
      if (!missing.length) return;
      mergeJson(this.settingsPath(), p => { p.packages = [...(Array.isArray(p.packages) ? p.packages : []), ...missing]; });
      diagnostics.push(`已自动恢复被覆盖的包注册：${missing.join('、')}（pi 会话写回旧设置副本所致）。`);
    } catch { /* 修复失败不影响快照 */ }
  }
  snapshot(cwd?:string):SettingsSnapshot {
    const diagnostics:string[]=[];let ai:any={};try{ai=readJson(this.settingsPath());}catch(e){diagnostics.push(String((e as Error).message));}
    this.repairPackages(diagnostics);
    const resources=this.resources(cwd),mcp:McpServerRow[]=[];
    for(const {root,scope}of this.roots(cwd)){const file=path.join(root,'mcp.json');try{const cfg=readJson(file);const seen=new Set<string>();const target=(c:any)=>c.command?path.basename(String(c.command)):(()=>{try{const url=new URL(c.url);return url.origin+url.pathname;}catch{return 'URL 无效';}})();for(const[name,c]of Object.entries(cfg.mcpServers||{}) as [string,any][]){seen.add(name);if(!object(c)){diagnostics.push(`MCP ${name} 配置无效`);continue;}mcp.push({id:hash(file+'\0'+name),name,scope,transport:c.command?'stdio':'Streamable HTTP',target:target(c),enabled:!c.disabled&&c.enabled!==false,path:file,revision:revision(file)});}for(const imp of this.mcpImports(cfg.imports)){if(seen.has(imp.name))continue;seen.add(imp.name);const c=imp.config as any;mcp.push({id:hash(imp.file+'\0'+imp.name),name:imp.name,scope,transport:c.command?'stdio':'Streamable HTTP',target:target(c),enabled:!c.disabled&&c.enabled!==false,path:imp.file,revision:revision(imp.file),source:imp.source});}}catch(e){diagnostics.push(`${file}：${(e as Error).message}`);}}
    const prefs=this.preferences(),sessions=this.host.index.scan(),paths=[...new Set([...prefs.projects.map(p=>p.path),...sessions.map(s=>s.cwd)].map(canonical))];
    const loadedExtensions=[path.join(this.policyDir,'index.mjs'),path.join(this.policyDir,'mcp-bridge.mjs'),path.join(this.policyDir,'..','desktop-ask','index.mjs'),path.join(this.policyDir,'..','desktop-subagent','index.mjs'),path.join(this.policyDir,'..','desktop-memory','index.mjs')].map(p=>path.resolve(p)).filter(p=>fs.existsSync(p));
    return {preferences:prefs,ai:{defaultProvider:String(ai.defaultProvider||''),defaultModel:String(ai.defaultModel||''),defaultThinkingLevel:String(ai.defaultThinkingLevel||'off'),autoCompact:ai.compaction?.enabled!==false,retry:ai.retry?.enabled!==false,revision:revision(this.settingsPath())},resources,mcp,mcpRevisions:Object.fromEntries(this.roots(cwd).map(r=>[r.scope,revision(path.join(r.root,'mcp.json'))])),diagnostics,projects:paths.map(p=>({path:p,name:prefs.projects.find(x=>canonical(x.path)===p)?.name||path.basename(p),registered:prefs.projects.some(x=>canonical(x.path)===p),exists:fs.existsSync(p),sessions:sessions.filter(s=>canonical(s.cwd)===p).length})),loadedExtensions};
  }
  saveAi(value:SettingsSnapshot['ai']) {if(!value||!['off','minimal','low','medium','high','xhigh','max'].includes(value.defaultThinkingLevel)||typeof value.autoCompact!=='boolean'||typeof value.retry!=='boolean'||typeof value.defaultProvider!=='string'||typeof value.defaultModel!=='string'||value.defaultProvider.length>200||value.defaultModel.length>200)throw new Error('AI 设置无效');mergeJson(this.settingsPath(),p=>{for(const k of ['defaultProvider','defaultModel']as const){if(value[k].trim())p[k]=value[k].trim();else delete p[k];}p.defaultThinkingLevel=value.defaultThinkingLevel;p.compaction={...p.compaction,enabled:value.autoCompact};p.retry={...p.retry,enabled:value.retry};},value.revision); }
  resources(cwd?:string):EditableResource[]{const out=new Map<string,EditableResource>();const roots=this.roots(cwd);const add=(file:string,kind:ResourceKind,scope:'user'|'project',status='discovered',detail='本地文件',editable=true)=>{const id=hash(file+'\0'+kind);out.set(id,{id,path:file,name:path.basename(file)==='SKILL.md'?path.basename(path.dirname(file)):path.basename(file),kind,scope,status,detail,editable:editable&&(!fs.existsSync(file)||fs.statSync(file).isFile())});};
    for(const r of this.host.resources(cwd)){if(!['extensions','skills','prompts'].includes(r.kind))continue;const kind=r.kind as ResourceKind;let paths=[r.path];if(fs.existsSync(r.path)&&fs.statSync(r.path).isDirectory())paths=kind==='extensions'?['index.ts','index.js','index.mjs'].map(n=>path.join(r.path,n)).filter(fs.existsSync):walk(r.path).filter(p=>kind==='skills'?path.basename(p)==='SKILL.md':p.endsWith('.md'));for(const p of paths){const editable=roots.some(x=>p.startsWith(path.join(x.root,kind)+path.sep)&&!p.includes(`${path.sep}node_modules${path.sep}`));add(p,kind,r.scope,r.status,r.detail,editable);}}
    for(const {root,scope}of roots){for(const p of walk(path.join(root,'agents')).filter(p=>p.endsWith('.md')))add(p,'subagents',scope);const file=path.join(root,'AGENTS.md');if(scope==='user'&&fs.existsSync(file))add(file,'instructions',scope);}
    const project=this.cwd(cwd);if(project){let dir=project;for(;;){const chosen=['AGENTS.override.md','AGENTS.md','CLAUDE.md'].map(n=>path.join(dir,n)).find(fs.existsSync);if(chosen)add(chosen,'instructions','project','discovered',dir===project?'当前项目指令':'继承的上级目录指令',dir===project);const next=path.dirname(dir);if(next===dir)break;dir=next;}}
    return [...out.values()];
  }
  private resource(id:string,cwd?:string){const r=this.resources(cwd).find(r=>r.id===id);if(!r)throw new Error('资源不存在，请刷新');return r;}
  resourcePath(id:string,cwd?:string){return this.resource(id,cwd).path;}
  readResource(id:string,cwd?:string):ResourceDocument {const r=this.resource(id,cwd);if(!fs.existsSync(r.path)||!fs.statSync(r.path).isFile())throw new Error('资源不是可读取的文件');if(fs.statSync(r.path).size>512*1024)throw new Error('文件超过 512 KiB，请在外部编辑器查看');return{id,text:fs.readFileSync(r.path,'utf8'),revision:revision(r.path)};}
  saveResource(input:{id:string;text:string;revision:string;cwd?:string}){const r=this.resource(input.id,input.cwd);if(!r.editable)throw new Error('包管理资源或继承指令请在原位置管理');if(typeof input.text!=='string')throw new Error('内容必须是文本');atomic(r.path,input.text,input.revision);}
  createResource(input:{kind:ResourceKind;scope:'user'|'project';name:string;text:string;cwd?:string}){if(!['instructions','skills','prompts','extensions','subagents'].includes(input.kind)||!['user','project'].includes(input.scope))throw new Error('资源类型无效');if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(input.name))throw new Error('名称仅允许字母、数字、短横线和下划线');const root=this.roots(input.cwd).find(r=>r.scope===input.scope)?.root;if(!root)throw new Error('请先选择项目');if(input.scope==='project'&&!fs.existsSync(path.dirname(root)))throw new Error('项目目录已失效，请重新选择目录');let file:string;
    if(input.kind==='instructions')file=path.join(input.scope==='project'?path.dirname(root):root,'AGENTS.md');else if(input.kind==='skills')file=path.join(root,'skills',input.name,'SKILL.md');else file=path.join(root,input.kind==='subagents'?'agents':input.kind,input.name+(input.kind==='extensions'?'.ts':'.md'));
    atomic(file,input.text,'missing');}
  toggleResource(id:string,enabled:boolean,cwd?:string){const r=this.resource(id,cwd);if(!['extensions','skills','prompts'].includes(r.kind))throw new Error('此资源不支持启停');const root=this.roots(cwd).find(x=>x.scope===r.scope)!.root;mergeJson(path.join(root,'settings.json'),p=>{const current=Array.isArray(p[r.kind])?p[r.kind]:[];p[r.kind]=[...current.filter((x:any)=>x!==r.path&&x!==`-${r.path}`&&x!==`+${r.path}`&&x!==`!${r.path}`),`${enabled?'+':'-'}${r.path}`];});}
  projectSave(value:ProjectUpdate){
    if(!value||typeof value.path!=='string'||!path.isAbsolute(value.path)||typeof value.name!=='string'||value.name.length>120||value.pinned!==undefined&&typeof value.pinned!=='boolean'||value.section!==undefined&&(typeof value.section!=='string'||value.section.length>60))throw new Error('项目参数无效');
    const p=canonical(value.path);
    if(value.remove && this.host.backend.runs().some(r=>canonical(r.cwd)===p && (r.status!=='idle'||r.pending>0||this.host.backend.hasPendingDialogs(r.key))))throw new Error('请先停止项目中运行的任务再移除。');
    if(!value.remove&&!fs.statSync(p).isDirectory())throw new Error('项目目录不存在');
    mergeJson(this.preferencesFile,v=>{
      const projects=Array.isArray(v.projects)?v.projects:[];
      const old=projects.find((x:any)=>canonical(x.path)===p);
      v.projects=projects.filter((x:any)=>canonical(x.path)!==p);
      const hidden=new Set<string>(Array.isArray(v.hiddenProjects)?v.hiddenProjects:[]);
      if(value.remove)hidden.add(p);
      else {hidden.delete(p);v.projects.push({...old,path:p,name:value.name.trim()||path.basename(p),...(value.pinned!==undefined?{pinned:value.pinned}:{}),...(value.section!==undefined?{section:value.section.trim()}: {})});}
      v.hiddenProjects=[...hidden];
    });
  }
  importFile(file:string){const stat=fs.statSync(file);if(stat.size>64*1024*1024)throw new Error('导入上限为 64 MiB');const raw=fs.readFileSync(file,'utf8');let entries:any[];try{entries=raw.split('\n').filter(l=>l.trim()).map(l=>JSON.parse(l));}catch{throw new Error('JSONL 损坏或含未完成尾行，未导入');}const header=entries[0];if(header?.type!=='session'||typeof header.id!=='string'||!path.isAbsolute(header.cwd||'')||entries.slice(1).some(e=>!object(e)||typeof e.type!=='string'))throw new Error('请选择 pi 原生会话 JSONL（不支持旧 Desktop events.jsonl）');
    const fingerprint=hash(raw),root=path.join(this.host.environment.agentDir,'sessions','desktop'),target=path.join(root,`import_${fingerprint}.jsonl`);if(fs.existsSync(target))return{key:fileKey(target),duplicate:true};fs.mkdirSync(root,{recursive:true});fs.writeFileSync(target,[JSON.stringify({...header,id:randomUUID(),parentSession:canonical(file)}),...entries.slice(1).map(e=>JSON.stringify(e)),''].join('\n'),{flag:'wx',mode:0o600});return{key:fileKey(target),duplicate:false};}
  mcpSave(input:{name:string;scope:'user'|'project';config?:string;enabled?:boolean;remove?:boolean;revision:string;cwd?:string}){if(!/^[a-zA-Z0-9][\w.-]{0,63}$/.test(input.name)||!['user','project'].includes(input.scope))throw new Error('MCP 名称或范围无效');const root=this.roots(input.cwd).find(x=>x.scope===input.scope)?.root;if(!root)throw new Error('请先选择项目');if(input.scope==='project'&&!fs.existsSync(path.dirname(root)))throw new Error('项目目录已失效，请重新选择目录');mergeJson(path.join(root,'mcp.json'),p=>{if(!object(p.mcpServers))p.mcpServers={};if(input.remove){delete p.mcpServers[input.name];return;}if(input.config!==undefined){const c=JSON.parse(input.config);if(!object(c)||(!c.command&&!c.url)||(c.command&&c.url))throw new Error('请配置 command 或 url 之一');if(c.command&&(typeof c.command!=='string'||(c.args!==undefined&&(!Array.isArray(c.args)||c.args.some((v:any)=>typeof v!=='string')))))throw new Error('command 必须是字符串，args 必须是字符串数组');if(c.url){const u=new URL(c.url);if(!['http:','https:'].includes(u.protocol))throw new Error('URL 必须为 HTTP(S)');}for(const key of ['env','headers'])if(c[key]!==undefined&&(!object(c[key])||Object.values(c[key]).some(v=>typeof v!=='string')))throw new Error(`${key} 必须是字符串映射`);p.mcpServers[input.name]=c;}if(!p.mcpServers[input.name])throw new Error('配置不存在');if(typeof input.enabled==='boolean'){p.mcpServers[input.name].disabled=!input.enabled;delete p.mcpServers[input.name].enabled;}},input.revision);}
  private mcpImports(imports:any):{name:string;config:any;source:string;file:string}[]{try{return (require(path.join(this.policyDir,'mcp-imports.cjs')) as any).resolveImports(imports);}catch{return [];}}
  async mcpTest(id:string,cwd?:string){const row=this.snapshot(cwd).mcp.find(x=>x.id===id);if(!row)throw new Error('MCP 配置不存在');let config:any;try{config=readJson(row.path).mcpServers?.[row.name];}catch{}if(!config&&row.source)config=this.mcpImports([row.source]).find(e=>e.name===row.name)?.config;if(!config)throw new Error('MCP 配置不存在或无法解析');const {McpClient}=require(path.join(this.policyDir,'mcp-client.cjs'));const childConfig={...config,env:{PATH:[path.dirname(this.host.environment.executable||'/usr/local/bin/pi'),'/opt/homebrew/bin','/usr/local/bin',process.env.PATH||''].join(path.delimiter),...config.env}};const client=new McpClient(childConfig,this.cwd(cwd)||this.host.environment.agentDir,{detached:true});try{await client.connect();const tools=await client.tools();return{tools:tools.map((t:any)=>String(t.name))};}finally{client.close();}}
  async runSubagent(id:string,cwd:string,task:string,parentKey?:string){const r=this.resource(id,cwd);if(r.kind!=='subagents')throw new Error('不是子代理定义');if(!task?.trim()||task.length>100000)throw new Error('请输入任务，最多 100000 字符');const doc=this.readResource(id,cwd);const match=doc.text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);const front=match?.[1]||'';const field=(key:string)=>front.match(new RegExp('^'+key+':\\s*(.+)$','m'))?.[1]?.trim();const tools=field('tools')?.split(',').map(x=>x.trim()).filter(Boolean);if(tools?.some(t=>!['read','bash','edit','write','grep','find','ls'].includes(t)))throw new Error('当前独立子代理只支持 pi 内置工具列表');const model=field('model');const parent=parentKey?this.host.backend.runs().find(r=>r.key===parentKey):undefined;if(parentKey&&!parent)throw new Error('父任务已失效');const run=await this.host.backend.connect({cwd:this.cwd(cwd),trustProject:false,permission:parent?.accessMode??'ask',systemPrompt:doc.text.slice(match?.[0].length||0),tools,model});void this.host.backend.prompt(run.key,task,'followUp').catch(()=>{});return run;}
}
