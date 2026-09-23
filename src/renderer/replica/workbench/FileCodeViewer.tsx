import {useEffect,useMemo,useRef} from 'react';
import hljs from 'highlight.js/lib/core';
import typescript from 'highlight.js/lib/languages/typescript';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
for(const [name,language] of Object.entries({typescript,javascript,json,css,xml,python,bash}))hljs.registerLanguage(name,language);
const languages:Record<string,string>={ts:'typescript',tsx:'typescript',js:'javascript',jsx:'javascript',mjs:'javascript',cjs:'javascript',json:'json',css:'css',html:'xml',svg:'xml',xml:'xml',py:'python',sh:'bash'};
export function FileCodeViewer({path,content,line=1}:{path:string;content:string;line?:number}){
  const scroller=useRef<HTMLDivElement>(null);
  const count=content.split('\n').length;
  const focus=Math.min(count,Math.max(1,line));
  const html=useMemo(()=>{
    const language=languages[path.split('.').pop()||''];
    // Large files remain selectable plain text without blocking the renderer on highlighting.
    return language&&content.length<=200000?hljs.highlight(content,{language,ignoreIllegals:true}).value:null;
  },[path,content]);
  useEffect(()=>{if(scroller.current)scroller.current.scrollTop=Math.max(0,(focus-4)*20);},[focus,path,content]);
  return <div className="pi-file-code" ref={scroller} aria-label={`文件内容 ${path}`}>
    <div className="pi-file-code__lines" aria-hidden="true">{Array.from({length:count},(_,i)=><div key={i} className={i+1===focus?'is-focused':''}>{i+1}</div>)}</div>
    <pre>{html===null?<code>{content}</code>:<code dangerouslySetInnerHTML={{__html:html}}/>}</pre>
  </div>;
}
