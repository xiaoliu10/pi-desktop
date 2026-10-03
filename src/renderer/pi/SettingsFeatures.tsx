import type { AccessMode } from '../../shared/access-mode';
import { Icon } from '../replica/Icons';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ARCHIVE_RETENTION_DAYS, DEFAULT_ARCHIVE_RETENTION_DAYS, DEFAULT_SHORTCUTS, type ResourceKind, type EditableResource, type ResourceDocument, type SettingsSnapshot, type ShortcutAction } from '../../shared/settings';
import type { SettingsNavId } from '../replica/contracts';
import { usePiStore } from './adapter';
import { ShortcutsPane } from './ShortcutsPane';
import { ArchivedSessions } from './ArchivedSessions';
import { UsagePane } from './UsagePane';
import './settings-features.css';
import { OfficialSubagentSetup } from './OfficialSubagentSetup';
import { VoicePane } from './VoicePane';
import { MemoryBrowser, MemorySwitch } from './MemoryControls';
const api = () => window.localPi;
const names: Record<string,string>={ai:'AI 默认行为',memory:'记忆',shortcuts:'快捷键',voice:'语音输入',instructions:'指令与提示词',skills:'技能',mcp:'MCP 服务',extensions:'扩展',subagents:'子代理',workspace:'连接',import:'导入会话',projects:'项目',archived:'已归档会话',usage:'数据统计'};
const actionNames:Record<ShortcutAction,string>={search:'全局搜索',newSession:'新建会话',settings:'打开设置',workbench:'显示 / 隐藏工作面板',sidebar:'折叠 / 展开侧栏',stop:'停止当前任务'};
const template=(kind:ResourceKind,name:string)=>kind==='extensions'?`export default function(pi) {\n  pi.registerCommand('${name}', {\n    description: '我的扩展命令',\n    handler: async (_args, ctx) => { ctx.ui.notify('扩展已运行'); }\n  });\n}\n`:kind==='skills'?`---\nname: ${name}\ndescription: 描述何时应该使用这个技能\n---\n\n# ${name}\n\n在这里填写步骤。\n`:kind==='subagents'?`---\nname: ${name}\ndescription: 专注的只读研究助手\ntools: read, grep, find, ls\n---\n\n你是一个只读研究助手。根据任务检查项目并给出结论，不修改文件。\n`:`# ${name}\n\n在这里填写指令。\n`;
export function SettingsFeatures({page,cwd,query,workspace,loadedExtensionPaths,extensionsContent}:{page:SettingsNavId;cwd?:string;query:string;workspace:ReactNode;loadedExtensionPaths?: string[];extensionsContent?:ReactNode}) {
  const [data,setData]=useState<SettingsSnapshot>();const [project,setProject]=useState(cwd||'');
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
  const [reloadBusy,setReloadBusy]=useState(false);
  const [editor,setEditor]=useState<(ResourceDocument & {resource:EditableResource})>();
  const [creating,setCreating]=useState(false),[kind,setKind]=useState<ResourceKind>('skills'),[scope,setScope]=useState<'user'|'project'>('user'),[name,setName]=useState(''),[content,setContent]=useState('');
  const [mcpName,setMcpName]=useState(''),[mcpConfig,setMcpConfig]=useState('{\n  "command": "npx",\n  "args": ["-y", "your-mcp-server"]\n}');
  const [mcpDialogOpen,setMcpDialogOpen]=useState(false);
  const mcpDialogRef=useRef<HTMLDialogElement>(null);
  useEffect(()=>{
    const dialog=mcpDialogRef.current;
    if(!dialog) return;
    if(mcpDialogOpen&&!dialog.open){const previous=document.activeElement as HTMLElement|null;dialog.showModal();return()=>{dialog.close();previous?.isConnected&&previous.focus();};}
    if(!mcpDialogOpen&&dialog.open)dialog.close();
    return undefined;
  },[mcpDialogOpen]);
  const [testResults,setTestResults]=useState<Record<string,string>>({});
  // MCP 连接状态点（ZCode 同款）：进入页面自动探测启用的服务——连接中橙点闪烁/成功绿点/失败红点/禁用灰点。
  const [probe,setProbe]=useState<Record<string,{state:'connecting'|'ok'|'failed';detail?:string}>>({});
  const probingRef=useRef<Set<string>>(new Set());
  const probeServer=useRef(async(id:string)=>{
    if(probingRef.current.has(id))return;
    probingRef.current.add(id);
    setProbe(v=>({...v,[id]:{state:'connecting'}}));
    try{ const result=await api().mcpTest(id,project||undefined); setProbe(v=>({...v,[id]:{state:'ok',detail:`${result.tools.length} 个工具`}})); }
    catch(e){ setProbe(v=>({...v,[id]:{state:'failed',detail:String((e as Error).message||e).slice(0,120)}})); }
    finally{ probingRef.current.delete(id); }
  });
  useEffect(()=>{ if(page!=='mcp'||!data) return;
    for(const r of data.mcp){ if(r.enabled&&probe[r.id]?.state!=='ok') void probeServer.current(r.id); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[page,data]);
  const [task,setTask]=useState(''),[agent,setAgent]=useState('');
  const [memStatus,setMemStatus]=useState<{enabled:boolean;plugin:{kind:'extension';id:string;label?:string}|{kind:'builtin'};builtinDir:string;hint:string}>();
  const sequence=useRef(0);
  async function load(){const n=++sequence.current;const value=await api().settingsSnapshot(project||undefined);if(n!==sequence.current)return;setData(value);usePiStore.setState({desktopPreferences:value.preferences});}
  async function act(fn:()=>Promise<unknown>,message?:string){if(busy)return;setBusy(true);setError('');try{await fn();await load();if(message)setNotice(message);}catch(e){setError(String((e as Error).message||e));}finally{setBusy(false);}}
  useEffect(()=>{setError('');setEditor(undefined);setCreating(false);void load().catch(e=>setError(String(e)));return()=>{sequence.current++;};},[project,page]);
  useEffect(()=>{const off=api().onEvent(e=>{if(e.type==='resources-changed')setNotice('磁盘资源已变化。请刷新列表；保存编辑时会检查版本，防止覆盖外部修改。');});return off;},[]);
  useEffect(()=>{ if(page!=='memory') return; let active=true; api().memoryAssistStatus(Boolean(data?.preferences.memoryAssist)).then(value=>{if(active)setMemStatus(value);}).catch(()=>{if(active)setMemStatus(undefined);}); return()=>{active=false;}; },[page,data?.preferences.memoryAssist]);
  const resourceKind:ResourceKind=page==='instructions'?'instructions':page==='subagents'?'subagents':page==='extensions'?'extensions':'skills';
  const resources=(data?.resources||[]).filter(r=>(r.kind===resourceKind||(page==='instructions'&&r.kind==='prompts'))&&`${r.name} ${r.path} ${r.detail}`.toLowerCase().includes(query.toLowerCase()));
  const beginCreate=(next:ResourceKind)=>{setKind(next);setName('my-'+next);setContent(template(next,'my-'+next));setCreating(true);setEditor(undefined);};
  const applyDefaults=async()=>{if(!data)return;await api().saveDesktopSettings({behavior:data.preferences.behavior,permission:data.preferences.permission});usePiStore.setState({behavior:data.preferences.behavior,desktopPreferences:data.preferences});};
  const saveArchivePrefs=async()=>{if(!data)return;await api().saveDesktopSettings({autoArchive:data.preferences.autoArchive??false,archiveRetentionDays:data.preferences.archiveRetentionDays??DEFAULT_ARCHIVE_RETENTION_DAYS});usePiStore.setState({desktopPreferences:data.preferences});};
  const resourcePages=['instructions','skills','subagents'].includes(page);
  return <div className="pi-features" aria-busy={busy}>
    <header className="pi-features__heading"><div><h1 className="pi-settings__title">{names[page]||page}</h1><p>真实本地设置 · 修改会保存到对应配置文件</p></div><button className="pi-btn pi-btn--outline" disabled={busy} onClick={()=>void act(load,'已刷新')}>刷新</button></header>
    {error&&<div className="pi-features__alert" role="alert">{error}</div>}{notice&&<div className="pi-features__notice" role="status">{notice}</div>}
    {/* 诊断提示只在与 mcp.json 相关的页面展示，避免在每个设置页顶部都出现。 */}
    {page==='mcp'&&data?.diagnostics.map(d=><p className="pi-features__alert" key={d}>{d}</p>)}
    {page==='subagents'&&<OfficialSubagentSetup onInstalled={load}/>}
    {/* ZCode 式资源范围选择：小型 pill 下拉（仅全局资源 / 项目名），右侧资源计数；授权提示收进 tooltip 与下方小字。 */}
    {['instructions','skills','subagents','mcp'].includes(page)&&(
      <div className="pi-features__scopebar">
        <label className="pi-features__scope" title="项目上下文：选择要查看/编辑的资源范围。项目资源运行时仍需在连接窗口授权。">
          <select value={project} onChange={e=>setProject(e.target.value)} aria-label="项目上下文">
            <option value="">仅全局资源</option>
            {data?.projects.map(p=><option key={p.path} value={p.path}>{p.name}</option>)}
          </select>
          <Icon name="chevron-down" size={13}/>
        </label>
        <span className="pi-features__count">{names[page]||page} {resources.length}{query?` · 匹配 ${resources.length}`:''}</span>
        {!project&&<span className="pi-features__scopehint">正在查看全局资源；选择项目可查看该项目 .pi/ 下的专属资源（运行时仍需在连接窗口授权）。</span>}
        {project&&<span className="pi-features__scopehint">正在查看 {data?.projects.find(p=>p.path===project)?.name||'项目'} 的专属资源；运行时仍需在连接窗口授权。</span>}
      </div>
    )}
    {!data&&!error&&<p>正在读取本地配置…</p>}
    {/* AI 默认行为/Desktop 执行偏好已并入通用页（PiReplicaApp generalSections 行内保存）；
        记忆独立成页（对齐 ZCode 独立记忆管理页），原 page==='ai' 入口随 AI 页移除而失效。 */}
    {data&&page==='memory'&&<section className="pi-features__card"><h2>记忆</h2>
        {/* ZCode 记忆页口径：开关 +「N 条记忆」+ 搜索 + 文件列表（相对时间）；点击行内预览 */}
        <MemorySwitch enabled={Boolean(data.preferences.memoryAssist)} disabled={busy} onSaving={setBusy} onSaved={enabled=>{setData(current=>current?{...current,preferences:{...current.preferences,memoryAssist:enabled}}:current);usePiStore.setState(state=>({desktopPreferences:{...(state.desktopPreferences??data.preferences),memoryAssist:enabled}}));}}/>
        <p className="pi-memory__hint">{memStatus ? `当前链路：${memStatus.plugin.kind==='extension'?(memStatus.plugin.label??memStatus.plugin.id)+'（用户已装，沿用）':'Desktop 内置桥（agentDir/memory/）'}。开启后每轮对话完成会自动整理记忆。` : '正在检测记忆链路…'}</p>
        {memStatus?.plugin.kind==='builtin'&&<div className="pi-features__actions"><button className="pi-btn pi-btn--primary" disabled={busy} onClick={()=>void act(async()=>{ await window.localPi!.memoryEnableDefault(); await api().memoryAssistStatus(true).then(setMemStatus); },'pi-memory 已安装并注册；新会话生效')}>安装内置记忆插件 pi-memory</button></div>}
        <MemoryBrowser cwd={cwd} projects={data.projects} globalDir={memStatus?.builtinDir}/>
      </section>}
    {data&&page==='shortcuts'&&<ShortcutsPane data={data} query={query} busy={busy} act={act}/>}
    {page==='voice'&&<VoicePane busy={busy} act={act}/>}
    {/* 扩展管理：完整能力（安装/启停/新建/源码编辑/内置扩展列表）由插件市场页内嵌于此（extensionsContent）。
        extensionsContent 缺省时（预览环境）退化为跳转提示。 */}
    {data&&page==='extensions'&&(extensionsContent??<section className="pi-features__card"><h2>扩展管理在「插件市场」</h2><p>安装与注册 npm 包、扩展启停、新建扩展、源码编辑与 Desktop 内置扩展列表，统一在「插件市场」管理。</p></section>)}
    {data&&resourcePages&&<>
      <div className="pi-features__actions"><button className="pi-btn pi-btn--primary" disabled={busy} onClick={()=>beginCreate(resourceKind)}>新建{names[page]}</button>{page==='instructions'&&<button className="pi-btn pi-btn--outline" onClick={()=>beginCreate('prompts')}>新建 / 提示词模板</button>}<button className="pi-btn pi-btn--outline" disabled={reloadBusy} onClick={()=>{ if (reloadBusy) return; setReloadBusy(true); void usePiStore.getState().rescanAndReload().then(r => { setNotice(r === 'reloaded' ? '已重载当前会话：扩展与资源已生效。' : r === 'failed' ? '重载会话失败，详情见通知。' : '已刷新资源列表；没有空闲会话可重载，空闲后再试。'); }).finally(() => setReloadBusy(false)); }}>{reloadBusy ? '重载中…' : '重载当前会话资源'}</button></div>
      <p>{page==='instructions'?'AGENTS.md 是常驻上下文指令；prompts/*.md 是 / 命令模板。上级目录指令只读展示。':page==='subagents'?'读取 agents/*.md。可作为独立 pi 会话运行，采用逐次确认权限；支持 tools（内置工具逗号列表）与 model 字段。它有独立上下文，不会自动将结果注入主会话。':'全局与选定项目资源直接来自 pi。发现不代表已加载；新增与启停在重载或下次连接时生效。'}</p>
      {creating&&<section className="pi-features__card"><h2>新建 {kind}</h2><label>范围<select value={scope} onChange={e=>setScope(e.target.value as typeof scope)}><option value="user">全局</option><option value="project" disabled={!project}>当前项目</option></select></label><label>名称<input value={name} onChange={e=>setName(e.target.value)}/></label><label>内容<textarea className="pi-features__code" rows={12} value={content} onChange={e=>setContent(e.target.value)}/></label><p>{kind==='extensions'?'扩展将作为本地代码执行，请审阅源码后再重载。':'资源以原生 pi 文件格式保存。'} 保存已有文件会被拒绝。</p><div className="pi-features__actions"><button className="pi-btn pi-btn--primary" disabled={busy} onClick={()=>void act(async()=>{await api().resourceCreate({kind,scope,name,text:content,cwd:project||undefined});setCreating(false);},'资源已创建；重载后生效')}>创建文件</button><button className="pi-btn pi-btn--outline" onClick={()=>setCreating(false)}>取消</button></div></section>}
      {editor&&<section className="pi-features__card"><h2>{editor.resource.name}</h2><code>{editor.resource.path}</code><textarea aria-label="资源内容" className="pi-features__code" rows={16} readOnly={!editor.resource.editable} value={editor.text} onChange={e=>setEditor({...editor,text:e.target.value})}/><p>保存前检查磁盘版本，并为原文件生成备份。包内资源与上级指令只读，避免破坏包管理器。</p><div className="pi-features__actions"><button className="pi-btn pi-btn--primary" disabled={busy||!editor.resource.editable} onClick={()=>void act(async()=>{await api().resourceSave({id:editor.id,text:editor.text,revision:editor.revision,cwd:project||undefined});setEditor(undefined);},'资源已保存；请重载运行中的会话')}>保存内容</button><button className="pi-btn pi-btn--outline" onClick={()=>setEditor(undefined)}>关闭编辑器</button></div></section>}
      {!resources.length&&<div className="pi-features__empty">{query?'没有匹配的资源。':'当前范围没有这类资源。可新建文件或切换项目；无需重新接入 pi。'}</div>}
      {resources.map(r=><article className="pi-features__row" key={r.id}><div><strong>{r.name}</strong><span className="pi-features__badge">{r.scope==='user'?'全局':'项目'} · {r.kind} · {r.status==='callable'?'命令可调用':r.status==='disabled'?'已排除':r.status==='missing'?'路径缺失':(loadedExtensionPaths?.includes(r.path)||data?.loadedExtensions?.includes(r.path))?'已加载':'加载未确认'}</span><code>{r.path}</code><p>{r.detail}</p></div><div className="pi-features__actions"><button className="pi-btn pi-btn--outline" disabled={busy} onClick={()=>void act(async()=>{const doc=await api().resourceRead(r.id,project||undefined);setEditor({...doc,resource:r});setCreating(false);})}>{r.editable?'查看 / 编辑':'查看'}</button><button className="pi-btn pi-btn--ghost" onClick={()=>void act(()=>api().revealResource(r.id,project||undefined))}>定位</button>{['extensions','skills','prompts'].includes(r.kind)&&<button className="pi-btn pi-btn--outline" disabled={busy} onClick={()=>void act(()=>api().resourceToggle(r.id,r.status==='disabled',project||undefined),'启停规则已保存；重载后生效')}>{r.status==='disabled'?'启用':'禁用'}</button>}{r.kind==='subagents'&&<button className="pi-btn pi-btn--primary" disabled={!project||busy} onClick={()=>{setAgent(r.id);setTask('');}}>运行独立会话</button>}</div></article>)}
      {agent&&<section className="pi-features__card"><h2>启动子代理</h2><p>工作目录：{project}。将调用本地 pi 与你配置的模型；从当前运行任务继承权限；独立启动默认变更前确认。</p><textarea aria-label="子代理任务" rows={4} value={task} onChange={e=>setTask(e.target.value)} placeholder="明确描述要交给这个子代理的任务…"/><div className="pi-features__actions"><button className="pi-btn pi-btn--primary" disabled={busy||!task.trim()} onClick={()=>void act(async()=>{const run=await api().runSubagent(agent,project,task,usePiStore.getState().runs.find(r=>r.key===usePiStore.getState().selectedKey)?.key);usePiStore.setState(s=>({runs:[...s.runs.filter(r=>r.key!==run.key),run]}));usePiStore.getState().selectSession(run.key);setAgent('');})}>创建并运行</button><button className="pi-btn pi-btn--outline" onClick={()=>setAgent('')}>取消</button></div></section>}
    </>}
    {data&&page==='mcp'&&<>
      <p>读取全局与项目 mcp.json 的 mcpServers，并解析 imports 从 claude-code / cursor / codex / opencode / claude-desktop 导入的 MCP 服务。pi ≥0.99 内置原生 MCP（builtin:mcp），自动连接此文件中的服务并暴露为 <code>mcp__服务器__工具</code>；旧版 pi（&lt;0.99）由 Desktop 自带的桥接管。本页支持 stdio 与 Streamable HTTP 两种传输；不自动启动服务，点「检测连接」才会运行对应命令或访问地址；启用/禁用写入 mcp.json 的 per-entry <code>enabled</code> 标志，下一次 pi 连接即生效。导入服务首次打开此页会被物化为真实条目（自动备份 .bak-pre099），随后可编辑/移除，但不再跟随来源工具配置变化。</p>
      <div className="pi-features__toolbar"><button className="pi-btn pi-btn--primary" onClick={()=>{setMcpName('');setMcpConfig('{\n  "command": "npx",\n  "args": ["-y", "your-mcp-server"]\n}');setMcpDialogOpen(true);}}>新增服务</button></div>
      {data.mcp.filter(r=>`${r.name} ${r.target} ${r.source??''}`.toLowerCase().includes(query.toLowerCase())).map(r=>{
          const pr=!r.enabled?{cls:'pi-mcpdot--off',label:'已禁用'}:(()=>{const p=probe[r.id];if(!p||p.state==='connecting')return{cls:'pi-mcpdot--wait',label:'连接中…'};return p.state==='ok'?{cls:'pi-mcpdot--ok',label:`已连接 · ${p.detail}`}:{cls:'pi-mcpdot--fail',label:`连接失败：${p.detail??''}`};})();
          return <article className="pi-features__row" key={r.id}><div><strong><span className={`pi-mcpdot ${pr.cls}`} role="img" aria-label={pr.label} title={pr.label}/>{r.name}</strong><span className="pi-features__badge">{r.source?`导入自 ${r.source}`:`${r.scope==='user'?'全局':'项目'} · ${r.transport}`} · {r.enabled?'已配置启用':'已禁用'}</span><code>{r.target}</code><p>{r.source?`${r.path}（由 ${r.source} 管理，编辑请到对应工具）`:r.path}</p>{testResults[r.id]&&<p role="status">{testResults[r.id]}</p>}</div><div className="pi-features__actions"><button className="pi-btn pi-btn--outline" disabled={busy} onClick={()=>void act(async()=>{const result=await api().mcpTest(r.id,project||undefined);setTestResults(v=>({...v,[r.id]:`连接成功 · ${result.tools.length} 个工具：${result.tools.join('、')||'无工具'}`}));setProbe(v=>({...v,[r.id]:{state:'ok',detail:`${result.tools.length} 个工具`}}));})}>检测连接</button><button className="pi-btn pi-btn--outline" disabled={busy} onClick={()=>void act(()=>api().mcpSave({name:r.name,scope:r.scope,enabled:!r.enabled,revision:r.source?(data.mcpRevisions[r.scope]||'missing'):r.revision,source:r.source,cwd:project||undefined}),`已${r.enabled?'停用':'启用'} ${r.name}；新建或重载会话生效`)}>{r.enabled?'禁用':'启用'}</button>{!r.source&&<><button className="pi-btn pi-btn--outline" disabled={busy} onClick={()=>void act(async()=>{const cfg=await api().mcpConfig(r.id,project||undefined);setMcpName(r.name);setScope(r.scope);setMcpConfig(cfg);setMcpDialogOpen(true);})}>修改</button><button className="pi-btn pi-btn--ghost" disabled={busy} onClick={()=>{if(window.confirm(`移除 ${r.name} 的 MCP 配置？原配置会先备份。`))void act(()=>api().mcpSave({name:r.name,scope:r.scope,remove:true,revision:r.revision,cwd:project||undefined}),'配置已移除');}}>移除</button></>}</div></article>;})}
      {!data.mcp.length&&<div className="pi-features__empty">未配置 MCP 服务。点击上方「新增服务」添加已有服务的命令或 HTTP 地址；本页面不会自动安装软件。</div>}
      <dialog ref={mcpDialogRef} className="pi-mcp-dialog" aria-labelledby="pi-mcp-dialog-title" onCancel={e=>{e.preventDefault();setMcpDialogOpen(false);}} onClick={e=>{if(e.target===e.currentTarget){const r=e.currentTarget.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)setMcpDialogOpen(false);}}}>
        <header className="pi-mcp-dialog__header"><h2 id="pi-mcp-dialog-title">添加 / 替换服务配置</h2><button type="button" className="pi-iconbtn" aria-label="关闭新增服务" onClick={()=>setMcpDialogOpen(false)}>×</button></header>
        <div className="pi-mcp-dialog__body">
          <label>范围<select value={scope} onChange={e=>setScope(e.target.value as typeof scope)}><option value="user">全局</option><option value="project" disabled={!project}>当前项目</option></select></label>
          <label>服务名称<input value={mcpName} onChange={e=>setMcpName(e.target.value)}/></label>
          <label>服务 JSON 配置<textarea aria-label="MCP 配置" rows={8} className="pi-features__code" value={mcpConfig} onChange={e=>setMcpConfig(e.target.value)} spellCheck={false}/></label>
          <p>stdio 使用 command / args / env；HTTP 使用 url / headers。认证仅存入原生 mcp.json，已有认证不会回填到页面。相同范围同名服务会完整替换，请提供完整配置。</p>
          <button className="pi-btn pi-btn--primary" disabled={busy||!mcpName.trim()} onClick={()=>{if(data.mcp.some(r=>r.name===mcpName&&r.scope===scope)&&!window.confirm('将完整替换同名服务，包括认证配置。继续？'))return;void act(async()=>{await api().mcpSave({name:mcpName,scope,config:mcpConfig,revision:data.mcpRevisions[scope]||'missing',cwd:project||undefined});setMcpName('');setMcpConfig('{}');setMcpDialogOpen(false);},'MCP 已保存；重载 pi 后注册工具');}}>保存完整配置</button>
        </div>
      </dialog>
    </>}
    {data&&page==='projects'&&<><section className="pi-features__card"><h2>自动归档旧任务</h2><label className="pi-features__check"><input type="checkbox" checked={data.preferences.autoArchive??false} onChange={e=>setData({...data,preferences:{...data.preferences,autoArchive:e.target.checked}})}/>开启自动归档</label><p>定时扫描最近打开过的工作区，将已完成、所属项目未置顶且超过保留期的任务自动归档。</p><label>归档保留时长<select value={data.preferences.archiveRetentionDays??DEFAULT_ARCHIVE_RETENTION_DAYS} onChange={e=>setData({...data,preferences:{...data.preferences,archiveRetentionDays:Number(e.target.value)}})}>{ARCHIVE_RETENTION_DAYS.map(d=><option key={d} value={d}>{d} 天后归档</option>)}</select></label><p>任务最后更新时间早于该时长，才会进入自动归档候选；运行中、排队或等待确认的任务不会被动。归档后可在“已归档”中恢复。</p><button className="pi-btn pi-btn--primary" disabled={busy} onClick={()=>void act(saveArchivePrefs,'自动归档设置已保存')}>保存归档设置</button></section><p>项目名称只保存在 Desktop；移除登记不会删除目录或 CLI 历史。已有 CLI 会话的项目仍会作为自动发现项显示。</p><button className="pi-btn pi-btn--primary" disabled={busy} onClick={()=>void act(async()=>{const chosen=await api().pickDirectory();if(chosen)await api().projectSave({path:chosen,name:chosen.split(/[\\/]/).at(-1)||chosen});},'项目列表已更新')}>添加本地项目</button>{data.projects.filter(p=>`${p.name} ${p.path}`.toLowerCase().includes(query.toLowerCase())).map(p=><ProjectRow key={p.path} project={p} busy={busy} act={act}/>)}{!data.projects.length&&<div className="pi-features__empty">还没有项目。添加目录后即可创建 pi 会话。</div>}</>}
    {page==='workspace'&&workspace}
    {page==='archived'&&<ArchivedSessions embedded/>}
    {page==='usage'&&<UsagePane/>}
    {data&&page==='import'&&<section className="pi-features__card"><h2>导入 pi 原生会话</h2><p>平时本机 CLI 会话会自动发现，无需导入。这里用于从其他目录、备份或设备导入 .jsonl 文件。</p><ul><li>验证完整 JSONL 与原生会话头，损坏文件不写入。</li><li>创建新的会话 ID，保留分支与扩展条目，原文件不变。</li><li>相同内容重复导入会返回已有副本，不生成重复记录。</li><li>不转换旧 Desktop events.jsonl 或其他产品格式。</li></ul><button className="pi-btn pi-btn--primary" disabled={busy} onClick={()=>void act(async()=>{const result=await api().importSession();if(!result)return;usePiStore.setState({sessions:await api().sessions()});usePiStore.getState().selectSession(result.key);},'导入处理完成')}>选择 JSONL 并导入副本</button><h2>直接观察额外目录</h2><p>如果想持续同步外部目录中的会话，使用「连接」页的额外会话目录，无需复制。</p><button className="pi-btn pi-btn--outline" onClick={()=>usePiStore.getState().openSettings('workspace')}>打开连接</button></section>}
  </div>;
}

function ProjectRow({project:p,busy,act}:{project:SettingsSnapshot['projects'][number];busy:boolean;act:(fn:()=>Promise<unknown>,message?:string)=>Promise<void>}){
  const api=()=>window.localPi;
  const [editing,setEditing]=useState(false);
  const [name,setName]=useState(p.name);
  return <article className="pi-features__row"><div><strong>{p.name}</strong><span className="pi-features__badge">{p.registered?'Desktop 登记':'CLI 自动发现'} · {p.sessions} 个会话{!p.exists?' · 目录失效':''}</span><code>{p.path}</code></div><div className="pi-features__actions"><button className="pi-btn pi-btn--primary" disabled={!p.exists} onClick={()=>{usePiStore.getState().startNewSession();usePiStore.setState({draftCwd:p.path});}}>新建会话</button>
  {editing?<><input aria-label="项目显示名称" value={name} maxLength={120} onChange={e=>setName(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'){setEditing(false);if(name.trim()&&name!==p.name)void act(()=>api().projectSave({path:p.path,name:name.trim()}),'项目名称已保存');}if(e.key==='Escape')setEditing(false);}} autoFocus/><button className="pi-btn pi-btn--primary" disabled={busy} onClick={()=>{setEditing(false);if(name.trim()&&name!==p.name)void act(()=>api().projectSave({path:p.path,name:name.trim()}),'项目名称已保存');}}>保存</button><button className="pi-btn pi-btn--ghost" onClick={()=>{setEditing(false);setName(p.name);}}>取消</button></>:<button className="pi-btn pi-btn--outline" disabled={busy} onClick={()=>{setName(p.name);setEditing(true);}}>重命名 / 登记</button>}
  {p.registered&&<button className="pi-btn pi-btn--ghost" disabled={busy} onClick={()=>void act(()=>api().projectSave({path:p.path,name:p.name,remove:true}),'登记已移除，磁盘与历史保持不变')}>移除登记</button>}</div></article>;
}
