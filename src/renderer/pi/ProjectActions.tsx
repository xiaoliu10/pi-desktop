import { useEffect, useRef, useState } from 'react';
import { onCloseTransientPopovers } from '../replica/popovers';
import { Icon } from '../replica/Icons';
import type { ProjectNavItem } from '../replica/contracts';
import { usePiStore } from './adapter';
type Action = 'edit'|'section'|'worktree'|'archive'|'remove';
export function ProjectActions({project}:{project:ProjectNavItem}) {
 const s=usePiStore();const saved=s.desktopPreferences?.projects.find(p=>p.path===project.path);
 const [open,setOpen]=useState(false),[position,setPosition]=useState({left:0,top:0});
 const [action,setAction]=useState<Action|null>(null),[name,setName]=useState(''),[section,setSection]=useState(''),[parent,setParent]=useState(''),[branch,setBranch]=useState('');
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(() => onCloseTransientPopovers(() => setOpen(false)), []);
 const root=useRef<HTMLDivElement>(null),dialog=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null);
 const zh=s.lang==='zh';
 useEffect(()=>{if(!open&&!action)return;const click=(e:MouseEvent)=>{if(!root.current?.contains(e.target as Node))setOpen(false);};const key=(e:KeyboardEvent)=>{if(e.key==='Escape'&&!busy){setOpen(false);setAction(null);trigger.current?.focus();}if(e.key==='Tab'&&action){const nodes=Array.from(dialog.current?.querySelectorAll<HTMLElement>('input,button:not(:disabled)')??[]),first=nodes[0],last=nodes.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}};document.addEventListener('mousedown',click);document.addEventListener('keydown',key);return()=>{document.removeEventListener('mousedown',click);document.removeEventListener('keydown',key);};},[open,action,busy]);
 const refresh=async()=>{const snapshot=await window.localPi!.settingsSnapshot();usePiStore.setState({desktopPreferences:snapshot.preferences});};
 const run=async(fn:()=>Promise<void>)=>{setBusy(true);setError('');try{await fn();setAction(null);setOpen(false);trigger.current?.focus();}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
 const update={...saved,path:project.path,name:project.name};
 const start=(next:Action)=>{setOpen(false);setError('');setAction(next);setName(next==='worktree'?`${project.name}-worktree`:project.name);setSection(saved?.section??'');setParent('');setBranch(`codex/worktree-${Date.now().toString(36)}`);};
 const save=()=>void run(async()=>{
   if(action==='edit')await window.localPi!.projectSave({...update,name});
   if(action==='section')await window.localPi!.projectSave({...update,section});
   if(action==='worktree'){const created=await window.localPi!.projectWorktree({projectPath:project.path,parentDirectory:parent,folder:name,branch});usePiStore.setState(state=>({expandedProjects:[...new Set([...state.expandedProjects,created.path])]}));}
   if(action==='archive') {const archivedKeys=await window.localPi!.projectArchive(project.path);usePiStore.setState({archivedKeys});}
   if(action==='remove')await window.localPi!.projectSave({...update,remove:true});
   await refresh();
   const state=usePiStore.getState(),currentCwd=state.runs.find(r=>r.key===state.selectedKey)?.cwd??state.sessions.find(r=>r.key===state.selectedKey)?.cwd;
   if((action==='remove'||action==='archive')&&currentCwd===project.path){const {draftText,contextItems}=state;state.startNewSession();usePiStore.setState({draftText,contextItems,...(action==='remove'?{draftCwd:undefined}:{})});}
   if(action==='remove'&&usePiStore.getState().draftCwd===project.path)usePiStore.setState({draftCwd:undefined});
 });
 const headings={edit:zh?'编辑项目':'Edit project',section:zh?'项目分区':'Project section',worktree:zh?'创建永久工作树':'Create permanent worktree',archive:zh?'归档项目聊天':'Archive project chats',remove:zh?'移除项目':'Remove project'};
 return <div className="pi-project-actions" ref={root} onClick={e=>e.stopPropagation()}>
  <button className="pi-sidebar__projectnew" aria-label={zh?`在 ${project.name} 新建会话`:`New session in ${project.name}`} title={zh?`在 ${project.name} 新建会话`:`New session in ${project.name}`} onClick={()=>{const store=usePiStore.getState();store.startNewSession();usePiStore.setState({draftCwd:project.path});}}><Icon name="plus" size={13}/></button>
  <button ref={trigger} className="pi-sidebar__projectmore" aria-label={`${zh?'项目操作':'Project actions'}：${project.name}`} aria-haspopup="menu" aria-expanded={open} onClick={e=>{const rect=e.currentTarget.getBoundingClientRect();setPosition({left:Math.max(8,rect.right-220),top:Math.max(8,Math.min(window.innerHeight-310,rect.bottom+4))});setOpen(v=>!v);setError('');}}><Icon name="more" size={15}/></button>
  {open&&<div className="pi-project-menu" style={position} role="menu" aria-label={zh?'项目操作':'Project actions'}>
    {error&&<p role="alert">{error}</p>}
    <button role="menuitem" autoFocus disabled={busy} onClick={()=>void run(async()=>{await window.localPi!.projectSave({...update,pinned:!saved?.pinned});await refresh();})}><Icon name="pin"/>{saved?.pinned?(zh?'取消置顶':'Unpin'):(zh?'置顶':'Pin')}</button>
    <button role="menuitem" onClick={()=>start('edit')}><Icon name="settings"/>{headings.edit}</button><hr/>
    <button role="menuitem" onClick={()=>start('section')}><Icon name="stack"/>{zh?'分区':'Section'}<small>{saved?.section??''}</small><Icon name="chevron-right" size={13}/></button>
    <button role="menuitem" disabled={busy} onClick={()=>void run(()=>window.localPi!.projectReveal(project.path))}><Icon name="folder"/>{navigator.platform.includes('Mac')?(zh?'在 Finder 中显示':'Show in Finder'):(zh?'在文件管理器中显示':'Show in file manager')}</button>
    <button role="menuitem" onClick={()=>start('worktree')}><Icon name="git-branch"/>{headings.worktree}</button><hr/>
    <button role="menuitem" onClick={()=>start('archive')}><Icon name="archive"/>{zh?'归档聊天':'Archive chats'}</button><hr/>
    <button role="menuitem" onClick={()=>start('remove')}><Icon name="x"/>{headings.remove}</button>
  </div>}
  {action&&<div className="pi-overlay"><div className="pi-project-dialog" role="dialog" aria-modal="true" aria-label={headings[action]} ref={dialog}>
    <h2>{headings[action]}</h2><p className="pi-project-dialog__path">{project.path}</p>
    {action==='edit'&&<label>{zh?'显示名称':'Display name'}<input autoFocus maxLength={120} value={name} onChange={e=>setName(e.target.value)}/></label>}
    {action==='section'&&<label>{zh?'选择已有分区，或输入新名称；留空回到默认项目列表。':'Choose or enter a section; leave empty for the default list.'}<input autoFocus list="pi-project-sections" maxLength={60} value={section} onChange={e=>setSection(e.target.value)}/><datalist id="pi-project-sections">{[...new Set(s.desktopPreferences?.projects.map(p=>p.section).filter(Boolean))].map(value=><option key={value} value={value}/>)}</datalist></label>}
    {action==='worktree'&&<><p>{zh?'从当前 HEAD 创建新分支与独立目录，保留原项目。未提交修改不会复制，工作树不会自动清理。':'Creates a new branch and directory from HEAD. Uncommitted changes are not copied; the worktree is kept permanently.'}</p><button className="pi-btn pi-btn--outline" disabled={busy} onClick={()=>void window.localPi!.pickDirectory().then(p=>{if(p)setParent(p);}).catch(e=>setError(e.message))}>{parent||(zh?'选择存放目录':'Choose parent directory')}</button><label>{zh?'新目录名称':'New folder'}<input autoFocus value={name} onChange={e=>setName(e.target.value)}/></label><label>{zh?'新分支名':'New branch'}<input value={branch} onChange={e=>setBranch(e.target.value)}/></label></>}
    {action==='archive'&&<p>{zh?'将该项目的全部聊天移入已归档列表，保留项目和原始会话文件。运行中的任务需要先停止。':'Moves all project chats to the archive, preserving the project and session files. Stop running tasks first.'}</p>}
    {action==='remove'&&<p>{zh?'只从 Desktop 项目列表移除，不删除本地目录、Git 工作树或 pi 聊天记录。重新添加该目录即可恢复显示。':'Hides this project in Desktop without deleting files, worktrees or chats. Add the folder again to restore it.'}</p>}
    {error&&<p role="alert" className="pi-project-dialog__error">{error}</p>}
    <footer><button className="pi-btn pi-btn--outline" disabled={busy} onClick={()=>setAction(null)}>{zh?'取消':'Cancel'}</button><button className="pi-btn pi-btn--primary" disabled={busy||(action==='edit'&&!name.trim())||(action==='worktree'&&(!parent||!name.trim()||!branch.trim()))} onClick={save}>{busy?(zh?'处理中…':'Working…'):action==='remove'?(zh?'移除':'Remove'):action==='archive'?(zh?'归档聊天':'Archive chats'):action==='worktree'?(zh?'创建':'Create'):(zh?'保存':'Save')}</button></footer>
  </div></div>}
 </div>;
}
