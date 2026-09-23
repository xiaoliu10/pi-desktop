import { useEffect, useRef, useState } from 'react';
import type { PiAccountLogin } from '../../shared/pi';
import { Icon } from '../replica/Icons';

export function AccountLoginDialog({provider,onClose,onDone}:{provider:{id:string;name:string};onClose:()=>void;onDone:()=>void}) {
  const [state,setState]=useState<PiAccountLogin>();
  const [error,setError]=useState(''),[value,setValue]=useState(''),[busy,setBusy]=useState(false);
  const ref=useRef<HTMLDialogElement>(null);
  const done=useRef(onDone);done.current=onDone;
  useEffect(()=>{
    const previous=document.activeElement as HTMLElement|null;
    ref.current?.showModal();
    let active=true,timer:ReturnType<typeof setTimeout>|undefined,finished=false,startedId:string|undefined;
    const poll=async(id:string)=>{
      try{
        const next=await window.localPi!.accountStatus(id);
        if(!active)return;
        setState(next);
        if(next.status==='waiting')timer=setTimeout(()=>void poll(id),700);
        else {finished=true;if(next.status==='done')done.current();}
      }catch{if(active)setError('无法获取登录状态，请关闭后重试。');}
    };
    void Promise.resolve().then(()=>active?window.localPi!.accountLogin(provider.id):undefined).then(next=>{
      if(!next)return;
      startedId=next.id;
      if(!active){void window.localPi!.accountCancel(next.id).catch(()=>{});return;}
      setState(next);void poll(next.id);
    }).catch(e=>{if(active)setError(String(e.message||e));});
    return ()=>{active=false;clearTimeout(timer);if(startedId&&!finished)void window.localPi!.accountCancel(startedId).catch(()=>{});ref.current?.close();if(previous?.isConnected)previous.focus();};
  },[provider.id]);
  useEffect(()=>{setValue(state?.prompt?.type==='select'?state.prompt.options?.[0]?.id??'':'');},[state?.prompt?.id]);
  const answer=async()=>{
    if(!state?.prompt||busy||!value.trim())return;
    setBusy(true);setError('');
    try{await window.localPi!.accountAnswer(state.id,state.prompt.id,value);setValue('');setState({...state,prompt:undefined});}
    catch(e){setError(String((e as Error).message||e));}finally{setBusy(false);}
  };
  return <dialog ref={ref} className="pi-provider-dialog" aria-labelledby="pi-account-title" onCancel={e=>{e.preventDefault();onClose();}}>
    <header className="pi-provider-dialog__header"><h2 id="pi-account-title">登录 {provider.name}</h2><button type="button" className="pi-iconbtn" aria-label="关闭登录" onClick={onClose}><Icon name="x" size={18}/></button></header>
    <div className="pi-providerform"><fieldset>
      <p role="status">{state?.message??'正在启动 pi 登录…'}</p>
      {state?.deviceCode&&<label><span>设备码</span><input readOnly value={state.deviceCode} onFocus={e=>e.target.select()}/></label>}
      {state?.url&&<button className="pi-btn pi-btn--primary" onClick={()=>void window.localPi!.accountOpen(state.id).catch(e=>setError(String(e.message||e)))}>在浏览器中打开授权页面</button>}
      {state?.prompt&&<form onSubmit={e=>{e.preventDefault();void answer();}}><label><span>{state.prompt.message}</span>{state.prompt.type==='select'?<select value={value} onChange={e=>setValue(e.target.value)}>{state.prompt.options?.map(o=><option key={o.id} value={o.id}>{o.label}</option>)}</select>:<input autoComplete="off" type={state.prompt.type==='secret'?'password':'text'} value={value} placeholder={state.prompt.placeholder} onChange={e=>setValue(e.target.value)}/>}</label><button className="pi-btn pi-btn--primary" disabled={busy||!value.trim()} type="submit">继续</button></form>}
      <p className="pi-providerform__hint">授权由 pi 官方登录流程完成。凭证与本地 pi CLI 共享；登录后新建会话使用更新后的模型列表。</p>
    </fieldset>{error&&<p role="alert" className="pi-providerform__err">{error}</p>}<footer className="pi-providerform__actions"><button className="pi-btn pi-btn--outline" onClick={onClose}>{state?.status==='done'?'完成':'关闭'}</button></footer></div>
  </dialog>;
}
