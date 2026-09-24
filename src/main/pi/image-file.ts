/** 与发送侧附件同一上限（attachments.ts 的 10 MiB）。 */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const DATA_URL = /^data:(image\/(png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/;

/** 校验并解码 data URL 图片（渲染层传来的消息附件），返回二进制与 mime。 */
export function imageDataUrl(dataUrl: unknown): { bytes: Buffer; mime: string } {
  if (typeof dataUrl !== 'string') throw new Error('图片数据无效');
  const match = DATA_URL.exec(dataUrl);
  if (!match) throw new Error('图片数据无效');
  const bytes = Buffer.from(match[3], 'base64');
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('图片数据无效或超过 10 MiB。');
  return { bytes, mime: match[1] };
}

/** 下载对话框的默认文件名：剥离非法字符，未带扩展名时按 mime 补。 */
export function imageFileName(name: unknown, mime: string): string {
  const base = (typeof name === 'string' ? name : '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim().slice(0, 100) || '图片';
  const ext = mime === 'image/jpeg' ? 'jpg' : mime.slice('image/'.length);
  return /\.[a-z0-9]{2,5}$/i.test(base) ? base : `${base}.${ext}`;
}
