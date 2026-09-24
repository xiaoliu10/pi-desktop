import { app, BrowserWindow, clipboard, dialog, nativeImage } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { bufferContext } from './composer-service';
import { imageDataUrl, imageFileName } from './image-file';
import type { AttachmentInput, ContextItem } from '../../shared/composer';

const MAX = 10 * 1024 * 1024;
async function attachment(name: string, buffer: Buffer, source = ''): Promise<ContextItem> {
  if (!buffer.length || buffer.length > MAX) throw new Error('附件为空或超过 10 MiB。');
  if (/\.(png|jpe?g|webp|gif|bmp|tiff?|heic)$/i.test(name)) {
    let image = nativeImage.createFromBuffer(buffer);
    if (image.isEmpty()) throw new Error('无法读取这张图片，请转换为 PNG 或 JPEG。');
    const size = image.getSize();
    if (Math.max(size.width, size.height) > 2048) image = image.resize(size.width >= size.height ? {width:2048} : {height:2048});
    const data = image.toPNG().toString('base64');
    if (data.length > MAX) throw new Error('图片过大，请缩小后重试。');
    return {id:source || randomUUID(),name,path:source,kind:'image',text:'',image:{type:'image',mimeType:'image/png',data}};
  }
  return bufferContext(name, buffer, source);
}
export async function readAttachment(file: string): Promise<ContextItem> {
  const real = await fs.realpath(file), stat = await fs.stat(real);
  if (!stat.isFile() || stat.size > MAX) throw new Error('请选择小于 10 MiB 的文件，不支持文件夹。');
  return attachment(path.basename(real), await fs.readFile(real), real);
}
export async function importAttachments(files: AttachmentInput[]): Promise<ContextItem[]> {
  if (!Array.isArray(files) || files.length > 10) throw new Error('一次最多添加 10 个附件。');
  let total = 0;
  for (const file of files) {
    if (typeof file?.name !== 'string' || !(file.bytes instanceof Uint8Array) || (total += file.bytes.byteLength) > 20*1024*1024) throw new Error('附件无效或总大小超过 20 MiB。');
  }
  return Promise.all(files.map(file => attachment(path.basename(file.name), Buffer.from(file.bytes))));
}
export async function clipboardAttachments(): Promise<ContextItem[]> {
  // File URLs are supplied by the OS clipboard; ordinary pasted text is never interpreted as a path.
  const formats = clipboard.availableFormats();
  const format = ['text/uri-list','public.file-url'].find(f => formats.includes(f));
  if (format) {
    const urls = clipboard.read(format).split(/[\r\n\0]+/).filter(s => s.startsWith('file://'));
    if (urls.length > 10) throw new Error('一次最多添加 10 个附件。');
    if (urls.length) return Promise.all(urls.map(url => readAttachment(fileURLToPath(url))));
  }
  const image = clipboard.readImage();
  if (!image.isEmpty()) return [await attachment('粘贴的图片.png', image.toPNG())];
  return [];
}

/** 已发送图片的下载：保存对话框（默认 Downloads）→ 原始字节落盘，取消返回空串。 */
export async function downloadImage(name: string, dataUrl: string): Promise<string> {
  const { bytes, mime } = imageDataUrl(dataUrl);
  const target = await dialog.showSaveDialog(BrowserWindow.getAllWindows()[0]!, {
    title: '保存图片',
    defaultPath: path.join(app.getPath('downloads'), imageFileName(name, mime)),
  });
  if (target.canceled || !target.filePath) return '';
  await fs.writeFile(target.filePath, bytes);
  return target.filePath;
}
