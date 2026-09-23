import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {projectFiles,projectContext,readContext} from '../src/main/pi/composer-service';
import {contextPrompt} from '../src/shared/composer';
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>fs.rm(root,{recursive:true,force:true})));});
async function setup(){const root=await fs.mkdtemp(path.join(os.tmpdir(),'pi-context-'));roots.push(root);return root;}
it('lists project files without dependencies and rejects escaped symlinks',async()=>{
 const root=await setup();const project=path.join(root,'project');await fs.mkdir(path.join(project,'node_modules'),{recursive:true});
 await fs.writeFile(path.join(project,'main.ts'),'export const value=1;');await fs.writeFile(path.join(project,'node_modules','huge.js'),'ignored');await fs.writeFile(path.join(root,'outside.txt'),'outside');await fs.symlink(path.join(root,'outside.txt'),path.join(project,'link.txt'));
 expect(await projectFiles(project)).toEqual(['main.ts']);
 expect((await projectContext(project,'main.ts')).text).toContain('value=1');
 await expect(projectContext(project,'link.txt')).rejects.toThrow('不在当前项目');
 await expect(projectContext(project,'../outside.txt')).rejects.toThrow('不在当前项目');
});
it('reads text documents and rejects binary, empty and oversized text',async()=>{
 const root=await setup(), file=path.join(root,'notes.md');await fs.writeFile(file,'# 本地资料');
 const doc=await readContext(file);expect(doc.kind).toBe('document');expect(doc.text).toBe('# 本地资料');
 expect(contextPrompt('总结文档',[doc])).toContain('# 本地资料');
 await fs.writeFile(file,Buffer.from([0,1,2]));await expect(readContext(file)).rejects.toThrow('二进制');
 await fs.writeFile(file,'');await expect(readContext(file)).rejects.toThrow('没有可提取');
 await fs.writeFile(file,'a'.repeat(60001));await expect(readContext(file)).rejects.toThrow('60000');
 expect(()=>contextPrompt('a'.repeat(190000),[doc])).toThrow('上下文过大');
});
it('extracts PDF text using the real document parser',async()=>{
 const root=await setup(), file=path.join(root,'notes.pdf');
 const stream='BT /F1 12 Tf 40 100 Td (Desktop document context) Tj ET';
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
 let pdf='%PDF-1.4\n', offsets=[0];objects.forEach((obj,i)=>{offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${obj}\nendobj\n`;});const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 6\n0000000000 65535 f \n`+offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')+`trailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n${xref}\n%%EOF\n`;
 await fs.writeFile(file,pdf);expect((await readContext(file)).text).toContain('Desktop document context');
});
it('extracts DOCX text using the real document parser',async()=>{
 const {createRequire}=await import('node:module');const require=createRequire(import.meta.url);
 const JSZip=require(require.resolve('jszip',{paths:[path.dirname(require.resolve('mammoth'))]}));
 const zip=new JSZip();
 zip.file('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
 zip.file('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
 zip.file('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Desktop Word context</w:t></w:r></w:p></w:body></w:document>');
 const file=path.join(await setup(),'notes.docx');await fs.writeFile(file,await zip.generateAsync({type:'nodebuffer'}));
 expect((await readContext(file)).text).toContain('Desktop Word context');
});

it('extracts pasted text bytes without a filesystem path and omits images from text context',async()=>{
 const {bufferContext}=await import('../src/main/pi/composer-service');
 const doc=await bufferContext('clipboard.md',Buffer.from('copied document'));
 expect(doc.text).toBe('copied document');expect(doc.id).toBeTruthy();
 expect(contextPrompt('describe',[{id:'image',name:'clip.png',path:'',kind:'image',text:'',image:{type:'image',data:'secret-base64',mimeType:'image/png'}}])).toBe('describe');
});
