import { useEffect, useRef, useState } from 'react';

export function OfficialSubagentSetup({onInstalled}:{onInstalled:()=>Promise<void>}) {
 const [status,setStatus]=useState<{installed:boolean;scoutExists:boolean;path:string}>();
 const [checking,setChecking]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const working=useRef(false);
 useEffect(()=>{let alive=true;
  window.localPi.officialSubagentStatus().then(value=>{if(alive)setStatus(value);}).catch(e=>{if(alive)setError(String(e.message||e));}).finally(()=>{if(alive)setChecking(false);});
  return()=>{alive=false;};
 },[]);
 async function install(){
  if(working.current)return;working.current=true;setBusy(true);setError('');setNotice('');
  try {
   const result=await window.localPi.enableOfficialSubagent();
   // Show success immediately; refreshing the full resource catalog is a separate operation.
   setStatus({installed:true,scoutExists:true,path:result.path});
   setNotice('启用成功。请新建会话以加载插件；已有会话不会自动重启。');
   setBusy(false);
   try{await onInstalled();}catch{setNotice('插件已安装，但资源列表刷新失败。可点击页面上方“刷新”重试。');}
  }catch(e){setError(String((e as Error).message||e));}
  finally{working.current=false;setBusy(false);}
 }
 const ready=status?.installed&&status.scoutExists;
 return <section className="pi-features__card" aria-busy={busy||checking}>
  <h2>子代理过程监控 · 官方插件</h2>
  <p>支持 pi 0.86 官方 subagent 扩展的单任务、并行与串行链。任务执行时，点击对话中的“子代理”查看任务、消息、工具过程和用量。</p>
  <p>官方插件的子进程没有 Desktop 审批通道，因此适配版只允许在完全访问模式中调用；不会自动切换权限。</p>
  <div className="pi-features__actions">
   <span role="status">{checking?'正在检查安装状态…':ready?'已安装 · 新会话加载':status?.installed?'已安装 · 缺少 desktop-scout 定义':'尚未安装'}</span>
   <button className={`pi-btn pi-btn--outline${ready&&!busy?' pi-subagent-enabled':''}`} disabled={checking||busy||!!ready} onClick={()=>void install()}>{checking?'正在检查…':busy?'正在启用…':ready?'✓ 已启用':'启用官方子代理插件'}</button>
   {ready&&<button className="pi-btn pi-btn--ghost" disabled={busy} onClick={()=>void install()}>重新安装 / 修复</button>}
  </div>
  {error&&<div className="pi-features__alert" role="alert">{error}</div>}
  {notice&&<div className="pi-features__notice" role="status">{notice}</div>}
  {ready&&<><p>在新会话中选择“完全访问”，然后发送：请使用 desktop-scout 子代理检查当前项目结构。</p><p>安装不会自动创建任务；子代理被调用后才会显示过程面板。</p><code>{status.path}</code></>}
 </section>;
}
