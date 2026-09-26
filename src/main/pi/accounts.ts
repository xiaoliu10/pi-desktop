import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import type { PiAccountLogin, PiCatalogProvider } from '../../shared/pi';
import type { PlanQuota } from '../../shared/context-details';
import { discoverPi } from './environment';
import { ACCOUNT_WORKER } from './account-worker';

export class PiAccounts {
  private child?: ChildProcessWithoutNullStreams;
  private state?: PiAccountLogin;
  private quotaCache = new Map<string, { value: PlanQuota; expires: number }>();
  constructor(private agentDir:()=>string) {}
  private spawn(operation:string,provider='') {
    const env=discoverPi({runtime:'bundled',agentDir:this.agentDir()});
    if(!env.executable||!env.launchArgs?.[0])throw new Error('模型目录、账号登录和套餐额度查询需要 Desktop 内置 pi 运行时，但运行时缺失或不可用。共享 pi 配置不等于已安装内置运行时。开发环境请运行 pnpm runtime:prepare；安装版请重新安装包含内置运行时且匹配架构的安装包。');
    const sdk=path.resolve(path.dirname(env.launchArgs[0]),'../core/model-runtime.js');
    return spawn(env.executable,['-e',ACCOUNT_WORKER,sdk,env.agentDir,operation,provider],{stdio:'pipe',env:{...process.env,PI_CODING_AGENT_DIR:env.agentDir}});
  }
  /** Whitelisted plan quota; runs in the pinned private runtime, never leaks credentials. */
  quota(provider:string):Promise<PlanQuota> {
    if(!/^[a-z0-9][a-z0-9_-]*$/i.test(provider))return Promise.reject(new Error('提供商无效'));
    const cached=this.quotaCache.get(provider);
    if(cached&&cached.expires>Date.now())return Promise.resolve(cached.value);
    return new Promise((resolve,reject)=>{
      let child:ChildProcessWithoutNullStreams;
      try{child=this.spawn('quota',provider);}catch(e){reject(e);return;}
      const timer=setTimeout(()=>{child.kill();reject(new Error('套餐查询超时'));},20000);
      const lines=createInterface({input:child.stdout});
      let result:PlanQuota|undefined;
      let failure:Error|undefined;
      lines.on('line',line=>{try{const m=JSON.parse(line);if(m.type==='quota'&&m.provider===provider)result={status:'ready',provider:m.provider,limits:m.limits.filter((l:{label?:unknown;remainingPercent:unknown;resetsAt?:unknown})=>typeof l.label==='string'&&l.label.length<=60&&typeof l.remainingPercent==='number'&&Number.isFinite(l.remainingPercent)&&(l.resetsAt===undefined||(typeof l.resetsAt==='number'&&l.resetsAt>0))),fetchedAt:Date.now()};}catch{}});
      child.stderr.resume(); // Credentials never cross stderr.
      child.once('error',e=>{clearTimeout(timer);failure=e instanceof Error?e:new Error(String(e));});
      child.once('close',code=>{clearTimeout(timer);lines.close();
        if(result){this.quotaCache.set(provider,{value:result,expires:Date.now()+60000});resolve(result);return;}
        reject(failure??new Error(`套餐查询失败（退出码 ${code}）`));
      });
    });
  }
  catalog():Promise<PiCatalogProvider[]> {
    return new Promise((resolve,reject)=>{
      let child:ChildProcessWithoutNullStreams;
      try{child=this.spawn('catalog');}catch(e){reject(e);return;}
      const timer=setTimeout(()=>{child.kill();reject(new Error('读取 pi 模型目录超时'));},20000);
      const lines=createInterface({input:child.stdout});
      let result:PiCatalogProvider[]|undefined;
      lines.on('line',line=>{try{const m=JSON.parse(line);if(m.type==='catalog')result=m.providers;}catch{}});
      child.stderr.resume();
      child.once('error',e=>{clearTimeout(timer);reject(e);});
      child.once('close',()=>{clearTimeout(timer);lines.close();result?resolve(result):reject(new Error('无法读取内置 pi 模型目录'));});
    });
  }
  start(provider:string):PiAccountLogin {
    if(this.child)throw new Error('已有登录流程正在进行');
    if(typeof provider!=='string'||!provider.trim())throw new Error('提供商无效');
    const child=this.spawn('login',provider), id=randomUUID();
    child.stdin.on('error',()=>{});
    this.child=child;
    this.state={id,provider,status:'waiting',message:'正在启动 pi 登录…'};
    const lines=createInterface({input:child.stdout});
    const update=(patch:Partial<PiAccountLogin>)=>{if(this.state?.id===id&&this.state.status==='waiting')this.state={...this.state,...patch};};
    lines.on('line',line=>{
      if(line.length>100000)return;
      try{
        const m=JSON.parse(line);
        if(m.type==='notify'){
          const e=m.event;
          if(e.type==='auth_url')update({url:this.safeUrl(e.url),message:e.instructions||'在浏览器完成授权。'});
          else if(e.type==='device_code')update({url:this.safeUrl(e.verificationUri),deviceCode:e.userCode,message:'打开登录页面并输入设备码。'});
          else update({message:e.message});
        } else if(m.type==='prompt')update({prompt:m.prompt});
        else if(m.type==='prompt-closed'&&this.state?.prompt?.id===m.id)update({prompt:undefined});
        else if(m.type==='done')update({status:'done',message:'登录成功，凭证已保存到 pi。',prompt:undefined,url:undefined,deviceCode:undefined});
        else if(m.type==='error')update({status:'error',message:m.message,prompt:undefined,url:undefined,deviceCode:undefined});
      }catch{}
    });
    child.stderr.resume(); // Never forward token-bearing SDK diagnostics to the renderer or logs.
    child.once('error',()=>update({status:'error',message:'无法启动 pi 登录进程',prompt:undefined}));
    child.once('close',()=>{lines.close();if(this.child===child)this.child=undefined;if(this.state?.id===id&&this.state.status==='waiting')update({status:'error',message:'登录流程已结束，请重试。',prompt:undefined,url:undefined,deviceCode:undefined});});
    return {...this.state};
  }
  status(id:string) {if(this.state?.id!==id)throw new Error('登录请求已失效');return {...this.state};}
  answer(id:string,promptId:string,value:string) {
    const s=this.status(id);
    if(s.status!=='waiting'||s.prompt?.id!==promptId||!this.child)throw new Error('登录问题已失效');
    if(typeof value!=='string'||value.length>16384)throw new Error('输入无效');
    if(s.prompt.type==='select'&&!s.prompt.options?.some(o=>o.id===value))throw new Error('选项无效');
    this.child.stdin.write(JSON.stringify({type:'answer',id:promptId,value})+'\n');
    this.state={...s,prompt:undefined};
  }
  cancel(id:string) {
    this.status(id);const child=this.child;this.child=undefined;
    this.state={...this.state!,status:'cancelled',message:'登录已取消',prompt:undefined,url:undefined,deviceCode:undefined};
    if(child){child.stdin.write('{"type":"cancel"}\n');const timer=setTimeout(()=>child.kill(),1500);timer.unref();child.once('close',()=>clearTimeout(timer));}
  }
  url(id:string) {const s=this.status(id);if(s.status!=='waiting'||!s.url)throw new Error('没有待打开的授权页面');return this.safeUrl(s.url)!;}
  private safeUrl(value:unknown) {if(typeof value!=='string')return;try{const u=new URL(value);return u.protocol==='https:'?u.href:undefined;}catch{return;}}
  dispose(){if(this.state&&this.child)this.cancel(this.state.id);}
}
