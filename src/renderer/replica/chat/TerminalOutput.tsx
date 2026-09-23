import {useEffect,useRef} from 'react';

/** Follow live output until the reader scrolls up; retain all supplied text. */
export function TerminalOutput({command,output,running}:{command?:string;output:string;running:boolean}){
 const viewport=useRef<HTMLPreElement>(null),following=useRef(true),streamed=useRef(running);
 useEffect(()=>{
  if(running)streamed.current=true;
  const el=viewport.current;
  if(el&&streamed.current&&following.current)el.scrollTop=el.scrollHeight;
 },[output,running]);
 return <div className="pi-terminal">
  {command&&<pre className="pi-terminal__command"><span className="pi-terminal__prompt">$</span> {command}</pre>}
  <pre className="pi-terminal__output" ref={viewport} tabIndex={0} aria-label="终端输出，可上下滚动" onScroll={event=>{const el=event.currentTarget;following.current=el.scrollHeight-el.scrollTop-el.clientHeight<=12;}}>{output|| (running?'正在执行…':'无文本输出。')}</pre>
 </div>;
}
