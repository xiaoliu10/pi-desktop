import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../replica/Icons';
import type { IconName } from '../replica/Icons';
import { FileIcon } from '../replica/FileIcon';
import type { ContextItem, ThinkingLevel } from '../../shared/composer';
import type { EditableResource } from '../../shared/settings';

export function ComposerAdd({cwd, disabled, onAdd}: {cwd?: string; disabled: boolean; onAdd: (items: ContextItem[])=>void}) {
  const [open,setOpen]=useState(false), [tab,setTab]=useState<'all'|'files'|'skills'>('all');
  const [query,setQuery]=useState(''), [files,setFiles]=useState<string[]>([]), [skills,setSkills]=useState<EditableResource[]>([]);
  const [busy,setBusy]=useState(false), [error,setError]=useState('');
  // 键盘高亮：↑/↓ 循环移动、Enter 选中；鼠标 hover 与键盘共用同一高亮。
  const [active,setActive]=useState(0);
  const root=useRef<HTMLDivElement>(null), trigger=useRef<HTMLButtonElement>(null), listRef=useRef<HTMLDivElement>(null);
  const listId=useId();
  useEffect(()=>{ if(!open) return; let active=true;
    setError(''); setBusy(true);
    Promise.all([cwd ? window.localPi!.projectFiles(cwd) : Promise.resolve([]),window.localPi!.composerSkills(cwd)])
      .then(([paths,choices])=>{if(active){setFiles(paths);setSkills(choices);}})
      .catch(e=>{if(active)setError(String(e.message));}).finally(()=>{if(active)setBusy(false);});
    return ()=>{active=false;};
  },[open,cwd]);
  useEffect(()=>{if(!open)return; const click=(e:MouseEvent)=>{if(!root.current?.contains(e.target as Node))setOpen(false);}; const key=(e:KeyboardEvent)=>{if(e.key==='Escape'){setOpen(false);trigger.current?.focus();}};document.addEventListener('mousedown',click);document.addEventListener('keydown',key);return()=>{document.removeEventListener('mousedown',click);document.removeEventListener('keydown',key);};},[open]);
  // 过滤、切页、重开面板时高亮重置到第一项。
  useEffect(()=>{setActive(0);},[query,tab,open]);
  const add=async(load:()=>Promise<ContextItem[]>)=>{setBusy(true);setError('');try{const items=await load();onAdd(items);if(items.length){setOpen(false);trigger.current?.focus();}}catch(e){setError(String((e as Error).message));}finally{setBusy(false);}};
  const selectSkill=(skill:EditableResource)=>add(async()=>{const doc=await window.localPi!.resourceRead(skill.id,cwd);return [{id:skill.id,name:skill.name,path:skill.path,kind:'skill',text:doc.text}];});
  const skillHits=skills.filter(r=>(r.name+' '+r.detail).toLowerCase().includes(query.toLowerCase()));
  const fileHits=files.filter(f=>f.toLowerCase().includes(query.toLowerCase()));
  // 键盘导航的扁平候选表，与列表 DOM 顺序严格一致（含「添加文档/添加项目上下文」动作行）。
  type OptRow={kind:'option';idx:number;key:string;icon:IconName;text:string;small?:string;disabled?:boolean;run:()=>void};
  type Row=OptRow|{kind:'heading';key:string;text:string};
  const rows:Row[]=[]; let optCount=0;
  const pushOpt=(key:string,icon:IconName,text:string,small:string|undefined,run:()=>void,disableWhenBusy=true)=>{
    rows.push({kind:'option',idx:optCount++,key,icon,text,small,run,disabled:disableWhenBusy&&busy});
  };
  if(tab==='all'&&!query){
    pushOpt('__docs','attach','添加文档','PDF、Word、Markdown、文本及代码文件',()=>void add(()=>window.localPi!.pickDocuments()));
    pushOpt('__files','folder','添加项目上下文',cwd || '先在输入框上方选择项目',()=>setTab('files'),false);
    rows.push({kind:'heading',key:'__heading',text:'本地 pi 技能'});
  }
  if(tab==='skills'||tab==='all') for(const skill of skillHits) pushOpt('skill:'+skill.id,'book',skill.name,skill.detail || skill.path,()=>void selectSkill(skill));
  if(tab==='files'||(tab==='all'&&!!query)) for(const file of fileHits.slice(0,100)) pushOpt('file:'+file,'file',file,undefined,()=>void add(async()=>[await window.localPi!.projectContext(cwd!,file)]));
  const options=rows.filter((r):r is OptRow=>r.kind==='option');
  const hi=options.length?Math.min(active,options.length-1):-1;
  // 高亮项跟随滚动（长列表键盘导航时保持可见）。
  useEffect(()=>{ if(hi<0)return; listRef.current?.querySelector(`[data-add-idx="${hi}"]`)?.scrollIntoView({block:'nearest'}); },[hi]);
  const onMenuKey=(e:React.KeyboardEvent<HTMLDivElement>)=>{
    if(e.key==='ArrowDown'||e.key==='ArrowUp'){
      if(!options.length)return;
      e.preventDefault();
      setActive(i=>(Math.min(i,options.length-1)+(e.key==='ArrowDown'?1:-1)+options.length)%options.length);
    } else if(e.key==='Enter'){
      if(e.nativeEvent.isComposing)return; // IME 组词中的 Enter 是选字，不是选中
      if(e.target instanceof HTMLButtonElement)return; // Tab 聚焦到某行时交给原生 click
      const opt=options[hi];
      if(opt&&!opt.disabled){e.preventDefault();opt.run();}
    }
    // Escape 走现有 document 级监听（关闭并回焦触发按钮）。
  };
  // 真实鼠标移动（movement≠0）才把高亮交给指针；键盘 ↑/↓ 触发 scrollIntoView 产生的合成 mousemove movement=0，忽略以免抢走键盘高亮。
  const hoverSync=(e:React.MouseEvent<HTMLButtonElement>,idx:number)=>{if(e.nativeEvent.movementX||e.nativeEvent.movementY)setActive(idx);};
  return <div className="pi-add" ref={root}>
    <button ref={trigger} className="pi-iconbtn" aria-label="添加上下文、文档或技能" title="添加上下文、文档或技能" aria-expanded={open} disabled={disabled} onClick={()=>{setOpen(v=>!v);setTab('all');setQuery('');}}><Icon name="plus" /></button>
    {open && <div className="pi-add__menu" role="dialog" aria-label="添加上下文" onKeyDown={onMenuKey}>
      <input autoFocus role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls={listId} aria-activedescendant={hi>=0?`${listId}-opt-${hi}`:undefined} value={query} onChange={e=>setQuery(e.target.value)} placeholder="搜索项目文件或技能…" aria-label="搜索项目文件或技能" />
      <div className="pi-add__tabs"><button aria-pressed={tab==='all'} onClick={()=>setTab('all')}>添加</button><button aria-pressed={tab==='files'} onClick={()=>setTab('files')}>项目上下文</button><button aria-pressed={tab==='skills'} onClick={()=>setTab('skills')}>使用技能</button></div>
      {error && <p role="alert" className="pi-add__error">{error}</p>}
      <div className="pi-add__list" role="listbox" id={listId} ref={listRef} aria-label="候选文件与技能">
        {busy && <p role="status">正在读取…</p>}
        {rows.map(row=>row.kind==='heading'
          ? <div className="pi-add__heading" key={row.key}>{row.text}</div>
          : <button key={row.key} role="option" id={`${listId}-opt-${row.idx}`} data-add-idx={row.idx} aria-selected={row.idx===hi} data-active={row.idx===hi?'true':undefined} disabled={row.disabled} onMouseMove={e=>hoverSync(e,row.idx)} onClick={()=>row.run()}><Icon name={row.icon}/><span>{row.text}{row.small?<small>{row.small}</small>:null}</span></button>)}
        {!busy && tab==='files' && !fileHits.length && <p>{cwd?'没有匹配的项目文件。':'请先选择项目目录。'}</p>}
        {!busy && tab!=='files' && !skillHits.length && <p>没有匹配的已启用技能。</p>}
        {tab==='files' && fileHits.length>100 && <p>显示前 100 项，请搜索缩小范围。</p>}
      </div>
      <footer>所选内容会在发送时加入本条消息，可在发送前移除。</footer>
    </div>}
  </div>;
}
/** 附件图片双击放大预览（点背景或按 Esc 关闭）。 */
const imageDataUrl = (item: ContextItem) => item.image ? `data:${item.image.mimeType};base64,${item.image.data}` : '';
function ImageLightbox({ src, name, onClose }: { src: string; name: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div className="pi-lightbox" role="dialog" aria-modal="true" aria-label={`预览 ${name}`} onClick={onClose}>
      <div className="pi-lightbox__bar" onClick={e => e.stopPropagation()}>
        <button type="button" className="pi-lightbox__btn" title="关闭" aria-label="关闭" onClick={onClose}><Icon name="x" size={22}/></button>
      </div>
      <img src={src} alt={name} onClick={e => e.stopPropagation()} />
    </div>, document.body,
  );
}

export function ContextChips({items,remove}: {items:ContextItem[];remove:(id:string)=>void}) {
  const [preview,setPreview]=useState<{src:string;name:string}|null>(null);
  // 附件被移除后关闭对应的预览。
  useEffect(()=>{ if(preview && !items.some(i=>imageDataUrl(i)===preview.src)) setPreview(null); },[items,preview]);
  return <>
    {items.length ? <div className="pi-context-chips">{items.map(item =>
      <span key={item.id} className={item.image ? 'pi-context-chip--image' : 'pi-context-chip--file'} title={item.path || item.name}>
        {item.image
          ? <img className="pi-attachment-thumbnail" src={imageDataUrl(item)} alt={item.name} title="双击放大预览" onDoubleClick={()=>setPreview({src:imageDataUrl(item),name:item.name})}/>
          : <>{item.kind==='skill' ? <Icon name="book" size={15}/> : <FileIcon path={item.path || item.name} size={15}/>}<span>{item.name}</span></>}
        <button type="button" aria-label={`移除 ${item.name}`} onClick={()=>remove(item.id)}><Icon name="x" size={12}/></button>
      </span>
    )}</div> : null}
    {preview && <ImageLightbox src={preview.src} name={preview.name} onClose={()=>setPreview(null)}/>}
  </>;
}
export function ProjectHeader({cwd,locked,onChoose,projects=[],onSelect}: {cwd?:string;locked:boolean;onChoose:()=>void;projects?:{path:string;name:string}[];onSelect?:(path:string)=>void}) {
 const [branch,setBranch]=useState<string|null>(null);
 const [open,setOpen]=useState(false),[query,setQuery]=useState('');
 const root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null);
 const close=()=>{setOpen(false);trigger.current?.focus();};
 useEffect(()=>{let active=true;setBranch(null);if(cwd)void window.localPi!.projectBranch(cwd).then(b=>{if(active)setBranch(b);}).catch(()=>{});return()=>{active=false;};},[cwd]);
 useEffect(()=>{setOpen(false);setQuery('');},[cwd,locked]);
 useEffect(()=>{if(!open)return;const outside=(e:MouseEvent)=>{if(!root.current?.contains(e.target as Node))setOpen(false);};document.addEventListener('mousedown',outside);return()=>document.removeEventListener('mousedown',outside);},[open]);
 const choices=[...new Map([...(cwd?[{path:cwd,name:projects.find(p=>p.path===cwd)?.name||cwd.split('/').filter(Boolean).pop()||cwd}]:[]),...projects].map(p=>[p.path,p])).values()];
 const hits=choices.filter(p=>(p.name+' '+p.path).toLowerCase().includes(query.trim().toLowerCase()));
 return <div className="pi-project-header"><div className="pi-project-picker" ref={root} onKeyDown={e=>{
   if(e.key==='Escape'){e.stopPropagation();close();}
   if(open&&(e.key==='ArrowDown'||e.key==='ArrowUp')){e.preventDefault();const items=Array.from(root.current?.querySelectorAll<HTMLButtonElement>('[data-project-choice]')||[]);const i=items.indexOf(document.activeElement as HTMLButtonElement);items[(i+(e.key==='ArrowDown'?1:-1)+items.length)%items.length]?.focus();}
 }}>
 <button ref={trigger} disabled={locked} onClick={()=>{setOpen(v=>!v);setQuery('');}} aria-label="选择项目" aria-haspopup="dialog" aria-expanded={open} title={cwd || '选择本地项目目录'}><Icon name="folder" size={15}/><span>{choices.find(p=>p.path===cwd)?.name || '选择项目'}</span>{!locked&&<Icon name="chevron-down" size={12}/>}</button>
 {open&&<div className="pi-project-picker__popover" role="dialog" aria-label="选择工作区">
   <label className="pi-project-picker__search"><Icon name="search" size={15}/><input autoFocus aria-label="搜索工作区" placeholder="搜索工作区" value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&hits.length){e.preventDefault();onSelect?.(hits[0].path);close();}}}/></label>
   <div className="pi-project-picker__list">{hits.map(project=><button key={project.path} data-project-choice aria-current={project.path===cwd?'true':undefined} title={project.path} onClick={()=>{onSelect?.(project.path);close();}}><Icon name="folder" size={15}/><span>{project.name}</span>{project.path===cwd&&<Icon name="check" size={14}/>}</button>)}{!hits.length&&<p>没有匹配的工作区</p>}</div>
   <div className="pi-project-picker__actions"><button data-project-choice onClick={()=>{close();onChoose();}}><Icon name="plus-square" size={15}/><span>打开文件夹</span></button></div>
 </div>}
 </div>{branch&&<span className="pi-project-header__branch"><Icon name="git-branch" size={14}/>{branch}</span>}</div>;
}
export const thinkingNames:Record<ThinkingLevel,string>={off:'关闭思考',minimal:'最少',low:'低',medium:'中',high:'高',xhigh:'超高',max:'最高'};

export { ContextUsageChip } from './ContextUsage';
export function ThinkingMenu({value,levels,disabled,onChange,pending}: {value:ThinkingLevel;levels:ThinkingLevel[];disabled:boolean;onChange:(v:ThinkingLevel)=>void;pending?:ThinkingLevel}) {
 const shown = pending ?? value;
 return <span className="pi-thinking-wrap" title={pending?'已选择，将在下一次模型调用时生效':undefined}><label className="pi-thinking" title={levels.length?'思考等级（由 pi 模型支持情况决定）':'当前模型未提供思考等级'}><Icon name="brain" size={17}/><select aria-label="思考等级" value={levels.includes(shown)?shown:levels[0]??'off'} disabled={disabled||levels.length<2} onChange={e=>onChange(e.target.value as ThinkingLevel)}>{(levels.length?levels:['off' as const]).map(level=><option key={level} value={level}>{thinkingNames[level]}</option>)}</select></label>{pending&&<span className="pi-pending-tag">待生效</span>}</span>;
}
