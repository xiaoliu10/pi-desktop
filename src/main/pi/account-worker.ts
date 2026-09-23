/** Runs only with Desktop's pinned private Node/pi SDK. No credentials cross stdout. */
export const ACCOUNT_WORKER = String.raw`
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const readline = require('node:readline');
const [modulePath, agentDir, operation, providerId] = process.argv.slice(1);
const send = data => process.stdout.write(JSON.stringify(data)+'\n');
const CONTROLLED = new Set(['read', 'create', 'list', 'add', 'update', 'delete', 'codeReview', 'health', 'storage', 'use', 'user', 'chaos', 'storage']);
const controller = new AbortController();
let pending, seq=0;
const input = readline.createInterface({input:process.stdin});
input.on('line', line=>{try {const msg=JSON.parse(line);if(msg.type==='cancel')controller.abort();if(msg.type==='answer'&&pending?.id===msg.id){const p=pending;pending=undefined;p.resolve(msg.value);}}catch{}});
(async()=>{
 const {ModelRuntime}=await import(pathToFileURL(modulePath).href);
 const runtime=await ModelRuntime.create({authPath:path.join(agentDir,'auth.json'),modelsPath:path.join(agentDir,'models.json'),modelsStorePath:path.join(agentDir,'models-store.json'),allowModelNetwork:false,signal:controller.signal});
 if(operation==='quota') {
  // Coding Plan quota needs OAuth subscription credentials; API keys have no plan endpoint.
  if(!runtime.isUsingSubscription(providerId))throw Object.assign(new Error('此提供商未使用订阅型套餐'),{code:'unsupported'});
  const auth=await runtime.getAuth(providerId);
  const base=auth?.auth?.baseUrl;
  if(typeof base!=='string'||!base.startsWith('https://api.z.ai'))throw Object.assign(new Error('仅支持智谱 / Z.ai 官方套餐查询'),{code:'unsupported'});
  const url=new URL(base.replace(/\/$/,'')+'/api/coding/pays/subscription/query_user_codization_resource');
  url.searchParams.set('enable_delay','false');
  const response=await fetch(url,{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10000)]),headers:auth.auth.headers??(auth.auth.apiKey?{Authorization:'Bearer '+auth.auth.apiKey}:{})});
  if(response.status===401)throw Object.assign(new Error('登录已过期'),{code:'unauthenticated'});
  if(!response.ok)throw Object.assign(new Error('套餐接口返回 '+response.status),{code:'unavailable'});
  const payload=await response.json();
  const raw=payload?.data??payload;
  const limits=(raw?.usage_quota_limits??raw?.usage_quota?.limits??[]).map(limit=>{
   const remaining=typeof limit?.percentage==='number'?Math.max(0,Math.min(100,100-limit.percentage)):null;
   return {label:String(limit?.name??limit?.type??'套餐'),remainingPercent:remaining,resetsAt:typeof limit?.reset_time==='number'?limit.reset_time*1000:undefined};
  }).filter(l=>l.remainingPercent!==null);
  if(!limits.length)throw Object.assign(new Error('套餐返回中没有可用额度字段'),{code:'unavailable'});
  send({type:'quota',provider:providerId,limits,fetchedAt:Date.now()});return;
 }
 if(operation==='catalog') {
  const credentials=await runtime.listCredentials();
  const providers=runtime.getProviders().filter(p=>p.auth.oauth||credentials.some(c=>c.providerId===p.id)).map(p=>({
   id:p.id,name:p.name,loginAvailable:!!p.auth.oauth,auth:credentials.find(c=>c.providerId===p.id)?.type??'none',source:'auth',
   models:runtime.getModels(p.id).map(m=>({id:m.id,name:m.name,contextWindow:m.contextWindow,maxTokens:m.maxTokens,reasoning:m.reasoning,input:m.input,thinkingLevelMap:m.thinkingLevelMap}))
  }));
  send({type:'catalog',providers});return;
 }
 if(!runtime.getProvider(providerId)?.auth.oauth)throw new Error('此提供商不支持套餐登录');
 await runtime.login(providerId,'oauth',{
  signal:controller.signal,
  notify:event=>send({type:'notify',event}),
  prompt:prompt=>new Promise((resolve,reject)=>{
   const id=String(++seq);
   const abort=()=>{if(pending?.id===id)pending=undefined;send({type:'prompt-closed',id});reject(new Error('登录已取消'));};
   if(prompt.signal?.aborted||controller.signal.aborted)return abort();
   const cleanup=()=>{prompt.signal?.removeEventListener('abort',abort);controller.signal.removeEventListener('abort',abort);};
   pending={id,resolve:value=>{cleanup();resolve(value);}};
   prompt.signal?.addEventListener('abort',abort,{once:true});controller.signal.addEventListener('abort',abort,{once:true});
   send({type:'prompt',prompt:{id,type:prompt.type,message:prompt.message,placeholder:prompt.placeholder,options:prompt.options}});
  })
 });
 try {await runtime.refresh({allowNetwork:true,providers:[providerId],signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)])});} catch {}
 send({type:'done'});
})().catch(()=>send({type:'error',message:'登录或模型目录读取失败，请检查网络、授权结果和 pi 配置后重试。'})).finally(()=>{input.close();process.stdout.write('',()=>process.exit());});
`;
