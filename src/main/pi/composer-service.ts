import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ContextItem } from '../../shared/composer';
const exec = promisify(execFile);
const ignored = new Set(['.git', 'node_modules', 'dist', 'build', '.pi', '.ssh', '.aws']);
export async function projectFiles(cwd: string): Promise<string[]> {
  const root = await fs.realpath(cwd), results: string[] = [];
  let visited = 0;
  async function walk(dir: string, depth: number) {
    if (depth > 8 || visited > 10000 || results.length >= 2000) return;
    for (const entry of await fs.readdir(dir, {withFileTypes:true})) {
      if (++visited > 10000 || results.length >= 2000) break;
      if (ignored.has(entry.name) || entry.name.startsWith('.env')) continue;
      const full = path.join(dir, entry.name);
      if(entry.isDirectory()) await walk(full,depth+1);
      else if(entry.isFile()) results.push(path.relative(root,full));
    }
  }
  await walk(root,0); return results.sort();
}
export async function readContext(file: string, kind: ContextItem['kind'] = 'document'): Promise<ContextItem> {
  const real = await fs.realpath(file), stat = await fs.stat(real);
  if (!stat.isFile() || stat.size > 10 * 1024 * 1024) throw new Error('请选择小于 10 MiB 的文件。');
  return bufferContext(path.basename(real), await fs.readFile(real), real, kind);
}
export async function bufferContext(name: string, buffer: Buffer, source = '', kind: ContextItem['kind'] = 'document'): Promise<ContextItem> {
  if (buffer.length > 10 * 1024 * 1024) throw new Error('请选择小于 10 MiB 的文件。');
  const ext = path.extname(name).toLowerCase();
  let text: string;
  if (ext === '.pdf') { const pdf = (await import('pdf-parse/lib/pdf-parse.js')).default; text = (await pdf(new Uint8Array(buffer), {version: 'v2.0.550'})).text; }
  else if(ext === '.docx') { const mammoth = await import('mammoth'); text = (await mammoth.extractRawText({buffer})).value; }
  else { if(buffer.includes(0)) throw new Error('暂不支持该二进制格式，请选择 PDF、DOCX 或文本文件。'); text=buffer.toString('utf8'); }
  if (!text.trim()) throw new Error('文件没有可提取的文字；扫描 PDF 请先进行 OCR。');
  if (text.length > 60000) throw new Error('文件文字超过 60000 字符，请拆分后添加。');
  return {id:source || crypto.randomUUID(),name,path:source,kind,text};
}
export async function projectContext(cwd: string, relative: string): Promise<ContextItem> {
  const root = await fs.realpath(cwd), target = await fs.realpath(path.resolve(root,relative));
  const rel=path.relative(root,target);
  if(rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel)) throw new Error('文件不在当前项目中，请通过添加文档选择。');
  return readContext(target,'file');
}
export async function projectBranch(cwd: string): Promise<string | null> {
  try { const {stdout}=await exec('git',['-C',cwd,'branch','--show-current'],{timeout:3000}); return stdout.trim() || 'detached HEAD'; } catch { return null; }
}
export async function skillChoices(resources: import('../../shared/settings').EditableResource[]) {
  const skills=resources.filter(r=>r.kind==='skills' && path.basename(r.path).toLowerCase()==='skill.md' && !['disabled','missing','error'].includes(r.status));
  return Promise.all(skills.map(async r=>{
    try {
      if((await fs.stat(r.path)).size > 512*1024) return {...r,detail:'技能文件较大'};
      const text=await fs.readFile(r.path,'utf8');const front=text.match(/^---\r?\n([\s\S]*?)\r?\n---/);const field=(key:string)=>front?.[1].match(new RegExp('^'+key+':\\s*(.+)$','m'))?.[1]?.trim().replace(/^['"]|['"]$/g,'');
      const description=field('description');
      return {...r,name:field('name')||path.basename(path.dirname(r.path)),detail:description && !['>','|'].includes(description)?description:(r.scope==='project'?'当前项目技能':'本地共享技能')};
    } catch {return {...r,detail:'无法读取技能文件'};}
  }));
}
