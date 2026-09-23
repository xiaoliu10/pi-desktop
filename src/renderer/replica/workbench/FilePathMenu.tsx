import {useEffect,useRef,useState} from 'react';
import {Icon} from '../Icons';

function normalize(value:string){
 const parts:string[]=[];
 for(const part of value.split('/')){if(!part||part==='.')continue;if(part==='..')parts.pop();else parts.push(part);}
 return '/'+parts.join('/');
}
export function fileCopyPaths(file:string,cwd?:string){
 const absolute=file.startsWith('/')?normalize(file):cwd?normalize(cwd+'/'+file):undefined;
 if(!absolute||!cwd)return {absolute,relative:undefined};
 const base=normalize(cwd).split('/').filter(Boolean),target=absolute.split('/').filter(Boolean);
 let common=0;while(common<base.length&&base[common]===target[common])common++;
 return {absolute,relative:[...base.slice(common).map(()=>'..'),...target.slice(common)].join('/')||'.'};
}
export function FilePathMenu({path,cwd}:{path:string;cwd?:string}){
 const [open,setOpen]=useState(false),[feedback,setFeedback]=useState('');
 const root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null);
 const paths=fileCopyPaths(path,cwd);
 useEffect(()=>{setOpen(false);setFeedback('');},[path,cwd]);
 useEffect(()=>{if(!open)return;const close=(e:PointerEvent)=>{if(!root.current?.contains(e.target as Node))setOpen(false);};document.addEventListener('pointerdown',close);root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();return()=>document.removeEventListener('pointerdown',close);},[open]);
 useEffect(()=>{if(!feedback)return;const timer=setTimeout(()=>setFeedback(''),2500);return()=>clearTimeout(timer);},[feedback]);
 async function copy(value:string,label:string){try{await navigator.clipboard.writeText(value);setFeedback(`已复制${label}`);}catch{setFeedback('复制失败，请重试');}setOpen(false);trigger.current?.focus();}
 return <div className="pi-file-path-menu" ref={root} onKeyDown={e=>{if(e.key==='Escape'){e.stopPropagation();setOpen(false);trigger.current?.focus();}if(open&&(e.key==='ArrowDown'||e.key==='ArrowUp')){e.preventDefault();const items=Array.from(root.current!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'));const index=items.indexOf(document.activeElement as HTMLButtonElement);items[(index+(e.key==='ArrowDown'?1:items.length-1))%items.length]?.focus();}}}>
  {feedback&&<span className="pi-file-path-menu__feedback" role="status">{feedback}</span>}
  <button ref={trigger} className="pi-iconbtn" aria-label={`文件操作 ${path}`} title="文件操作" aria-haspopup="menu" aria-expanded={open} onClick={()=>setOpen(!open)}><Icon name="more" size={16}/></button>
  {open&&<div className="pi-file-path-menu__popup" role="menu" aria-label="复制文件路径">
   <button role="menuitem" disabled={!paths.absolute} onClick={()=>void copy(paths.absolute!,'绝对路径')}><Icon name="copy" size={15}/>复制绝对路径</button>
   <button role="menuitem" disabled={!paths.relative} title={!cwd?'未选择项目目录':`相对于 ${cwd}`} onClick={()=>void copy(paths.relative!,'相对路径')}><Icon name="copy" size={15}/>复制相对路径</button>
  </div>}
 </div>;
}
