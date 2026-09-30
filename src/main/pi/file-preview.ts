import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
/** 常见图片扩展名 → mime：这类文件不走文本预览，按图像渲染。 */
const IMAGE_MIME: Record<string, string> = {'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.bmp':'image/bmp'};
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export async function filePreview(cwd:string, file:string):Promise<{path:string;content?:string;diff:string;note:string;image?:{mime:string;base64:string}}> {
  if(typeof cwd!=='string'||!path.isAbsolute(cwd)||typeof file!=='string'||!file||file.includes('\0')) throw new Error('文件路径无效');
  const target=path.resolve(cwd,file);
  let content:string|undefined, note='当前磁盘内容；不是当时工具读取的历史快照。', image:{mime:string;base64:string}|undefined;
  try {
    const stat=await fs.stat(target);
    if(!stat.isFile()) throw new Error('该路径不是普通文件');
    const mime=IMAGE_MIME[path.extname(target).toLowerCase()];
    if(mime && stat.size<=MAX_IMAGE_BYTES) {
      // 图片：内嵌 base64 供渲染层 <img> 预览（10 MiB 上限，超限按二进制文案提示）。
      const buffer=await fs.readFile(target);
      image={mime, base64:buffer.toString('base64')};
      note='图片文件，已在下方生成图像预览；不是文本内容。';
    }
    else if(stat.size>2*1024*1024) note='文件超过 2 MiB，暂不展示完整内容。';
    else {const buffer=await fs.readFile(target);if(buffer.includes(0))note='二进制文件暂不支持预览。';else content=buffer.toString('utf8');}
  } catch(e) {if((e as NodeJS.ErrnoException).code==='ENOENT')note='文件已不存在。';else throw e;}
  const git=async(args:string[])=>(await exec('git',['--literal-pathspecs','-c','core.fsmonitor=false',...args],{cwd:path.dirname(target),timeout:10000,maxBuffer:2*1024*1024,env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}})).stdout;
  let diff='';
  try {
    await git(['rev-parse','--show-toplevel']);
    let base='HEAD';try{await git(['rev-parse','--verify','HEAD']);}catch{base='4b825dc642cb6eb9a060e54bf8d69288fbee4904';}
    diff=await git(['diff','--no-ext-diff','--no-textconv',base,'--',target]);
    if(diff)note='当前文件相对 Git HEAD 的净变化，包含已暂存和未暂存修改；不是单次工具调用的差异。';
    else if(content!==undefined)note+=' 当前文件没有 Git 差异，或尚未被 Git 跟踪。';
  }catch{note+=' Git 差异不可用（非 Git 目录、目录不存在或读取失败）。';}
  return {path:target,content,diff,note,image};
}
