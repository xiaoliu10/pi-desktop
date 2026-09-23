import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
/** Desktop-only metadata: native pi session files are never modified. */
export class SessionArchive {
  constructor(private file: string) {}
  list(): string[] {
    if(!fs.existsSync(this.file)) return [];
    const value=JSON.parse(fs.readFileSync(this.file,'utf8'));
    if(!Array.isArray(value)||value.some(key=>typeof key!=='string')) throw new Error('归档索引损坏，请先备份并检查归档配置。');
    return [...new Set(value)];
  }
  set(key: string, archived: boolean, busy = false): string[] {
    if(typeof key!=='string'||!key||key.length>512||typeof archived!=='boolean') throw new Error('归档参数无效');
    if(archived&&busy) throw new Error('任务仍在运行或等待确认，请先停止任务再归档。');
    return this.setMany([key],archived);
  }
  setMany(values: string[], archived: boolean): string[] {
    const keys=new Set(this.list()); values.forEach(key=>archived ? keys.add(key) : keys.delete(key));
    fs.mkdirSync(path.dirname(this.file),{recursive:true});
    const temporary=this.file+'.'+randomUUID()+'.tmp';
    try { fs.writeFileSync(temporary,JSON.stringify([...keys]),{mode:0o600,flag:'wx'});fs.renameSync(temporary,this.file); }
    finally {if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
    return [...keys];
  }
}
