import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { WorktreeInput, DesktopProject } from '../../shared/projects';
const exec=promisify(execFile);
export async function createProjectWorktree(input:WorktreeInput):Promise<DesktopProject> {
 if(!input||typeof input.projectPath!=='string'||typeof input.parentDirectory!=='string'||!path.isAbsolute(input.projectPath)||!path.isAbsolute(input.parentDirectory)||typeof input.folder!=='string'||!input.folder.trim()||input.folder!==path.basename(input.folder)||['.','..'].includes(input.folder)||/[\\\0]/.test(input.folder)||typeof input.branch!=='string'||!input.branch.trim()||input.branch.startsWith('-'))throw new Error('请输入有效的目录名称和新分支名。');
 const root=await fs.realpath(input.projectPath), parent=await fs.realpath(input.parentDirectory);
 if(!(await fs.stat(parent)).isDirectory())throw new Error('目标父目录不存在。');
 const destination=path.join(parent,input.folder);
 try{await fs.lstat(destination);throw new Error('目标目录已存在，请使用新的目录名称。');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 await exec('git',['-C',root,'rev-parse','--show-toplevel'],{timeout:5000});
 await exec('git',['check-ref-format','--branch',input.branch],{timeout:5000});
 try {await exec('git',['-C',root,'worktree','add','-b',input.branch,destination,'HEAD'],{timeout:120000,maxBuffer:1024*1024});}
 catch(e){throw new Error(`创建工作树失败：${String((e as {stderr?:string}).stderr||(e as Error).message).slice(0,2000)}`);}
 return {path:await fs.realpath(destination),name:input.folder};
}
