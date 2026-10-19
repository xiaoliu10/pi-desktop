/** 灯箱下载的 URL 归一化：把渲染侧的 blob: URL 转成主进程认的 base64 data URL。
 *
 *  为什么需要：聊天图片用 image-url.ts 的 URL.createObjectURL（blob: URL，为压 base64
 *  常驻内存），而主进程 image-file.ts 的 imageDataUrl 只接受 `data:image/...;base64,`。
 *  直接把 blob: 传过 IPC，主进程在校验处就抛「图片数据无效」——0.1.28 起附件图片的
 *  「下载原图」按钮一直是坏的（点下去只有一句通用失败，保存对话框都不弹）。
 *
 *  blob: 是渲染进程内存对象，主进程无法解析，只能在本进程读回字节再编码。只在用户点
 *  下载时发生一次，不参与渲染热路径（不回到「每拍拼 base64」的老路）。
 *
 *  data: URL（直连生图卡片）原样返回，不做无谓的往返。
 */

/** 读 blob 字节并编码为 `data:<mime>;base64,<...>`。FileReader 与手工编码两条路都支持：
 *  浏览器用 FileReader（不占 JS 堆），Node（vitest）没有 FileReader 就走 Buffer/Uint8Array。 */
async function blobToDataUrl(blob: Blob): Promise<string> {
  const type = blob.type || 'application/octet-stream';
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  // eslint-disable-next-line no-undef -- 浏览器与 Node 都有 btoa
  return `data:${type};base64,${btoa(binary)}`;
}

/** 把图片 URL 归一化为 data URL。blob: 走 fetch→base64；其他（含 data:）原样返回。 */
export async function toDataUrlForDownload(url: string): Promise<string> {
  if (!url.startsWith('blob:')) return url;
  const blob = await fetch(url).then(r => r.blob());
  return blobToDataUrl(blob);
}
