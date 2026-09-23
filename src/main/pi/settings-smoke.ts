import fs from 'node:fs';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
/** Invoked only with PI_SMOKE_SETTINGS=1 against an explicitly isolated agentDir. */
export async function settingsSmoke(win: BrowserWindow, outputDir: string) {
  if (!process.env.PI_CODING_AGENT_DIR || !process.env.PI_DESKTOP_DATA_DIR) throw new Error('Settings smoke requires isolated paths');
  fs.mkdirSync(outputDir,{recursive:true});
  const js=(source:string)=>win.webContents.executeJavaScript(source);
  const delay=()=>new Promise(r=>setTimeout(r,180));
  const click=async(text:string,selector='button')=>{await js(`(()=>{const el=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!el)throw Error('Button missing: '+${JSON.stringify(text)});el.click();})()`);await delay();};
  const set=async(selector:string,value:string)=>{await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Input missing');Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);await delay();};
  await js(`(()=>{const b=document.querySelector('button[aria-label="设置"]');if(!b)throw Error('Settings entry missing');b.click();})()`);await delay();
  const nav=await js(`Array.from(document.querySelectorAll('.pi-settings__navitem')).map(e=>e.textContent.trim())`);
  const visited=[];
  for(const name of nav){await click(name,'.pi-settings__navitem');const text=await js('document.body.innerText');if(text.includes('接入本地 pi 后')||text.includes('这里还没有内容'))throw new Error(`Placeholder remains: ${name}`);if(await js(`!!document.querySelector('.pi-features__alert')`))throw new Error(`Settings error: ${name}`);visited.push(name);}
  await click('AI','.pi-settings__navitem');
  await set('.pi-features__card input','test-provider');await click('保存 pi 默认值');
  const provider=await js(`window.localPi.settingsSnapshot().then(s=>s.ai.defaultProvider)`);if(provider!=='test-provider')throw new Error('AI edit did not persist');
  await click('快捷键','.pi-settings__navitem');await set('input[aria-label="全局搜索"]','Mod+Shift+K');await click('保存快捷键');
  await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'K',metaKey:true,shiftKey:true,bubbles:true}))`);await delay();
  const opened=await js(`!!document.querySelector('.pi-searchdialog') || !!document.querySelector('input[placeholder*="搜索会话"]') || document.querySelectorAll('[role="dialog"]').length>0`);if(!opened)throw new Error('Saved shortcut did not open search');
  await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);await delay();
  await click('技能','.pi-settings__navitem');await click('新建技能');await click('创建文件');
  const resources=await js(`window.localPi.settingsSnapshot().then(s=>s.resources)`);if(!resources.some((r:any)=>r.name==='my-skills'))throw new Error('Skill was not created');
  await click('查看 / 编辑');await set('textarea[aria-label="资源内容"]','---\nname: my-skills\ndescription: Edited in desktop smoke\n---\n# Updated skill');await click('保存内容');
  await click('禁用');
  const disabled=await js(`window.localPi.settingsSnapshot().then(s=>s.resources.find(r=>r.name==='my-skills')?.status)`);if(disabled!=='disabled')throw new Error('Skill disable did not persist');
  fs.writeFileSync(path.join(outputDir,'settings-skills.png'),(await win.webContents.capturePage()).toPNG());
  await click('MCP','.pi-settings__navitem');
  fs.writeFileSync(path.join(outputDir,'settings-mcp.png'),(await win.webContents.capturePage()).toPNG());
  await click('项目','.pi-settings__navitem');
  fs.writeFileSync(path.join(outputDir,'settings-projects.png'),(await win.webContents.capturePage()).toPNG());
  return { visited, aiSaved:true, shortcutApplied:true, skillCreatedEditedDisabled:true };
}
