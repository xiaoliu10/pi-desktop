import { describe, expect, it, vi } from 'vitest';
import { toDataUrlForDownload } from '../src/shared/image-download';
import { imageDataUrl } from '../src/main/pi/image-file';

// 灯箱下载端到端契约：渲染侧图片是 blob: URL，主进程 imageDataUrl 只认 data URL。
// 0.1.28 引入 blob URL 时漏了这一环——附件图片「下载原图」点了只有一句「图片保存失败」，
// 保存对话框都不弹（主进程在校验处抛，前端 .catch 吞成通用错误）。
// 本用例钉住：归一化输出必须能通过主进程的同一套校验，而不是「看起来像 data URL」。

const PNG_PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAADJRU5ErkJggg==';

describe('download URL normalization', () => {
  it('passes data URLs through untouched (direct image-gen cards)', async () => {
    expect(await toDataUrlForDownload(PNG_PIXEL)).toBe(PNG_PIXEL);
  });

  it('converts a blob: URL into a data URL the main process accepts', async () => {
    const bytes = Uint8Array.from(atob(PNG_PIXEL.split(',')[1]), c => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: 'image/png' });
    const objectUrl = URL.createObjectURL(blob);
    try {
      const dataUrl = await toDataUrlForDownload(objectUrl);
      expect(dataUrl.startsWith('data:image/png;base64,')).toBe(true);
      // 关键：不是「像个 data URL」，而是真能过主进程那套校验
      const decoded = imageDataUrl(dataUrl);
      expect(decoded.mime).toBe('image/png');
      expect(decoded.bytes.length).toBe(bytes.length);
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  });

  it('propagates fetch failures instead of silently sending an unusable URL', async () => {
    // blob: 已被 revoke / 不存在时 fetch 必失败——不能退化成「把 blob: 原样发给主进程」
    // （那正是 0.1.28 的 bug 形态：用户看到通用失败，根因不可见）。
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('blob gone'));
    await expect(toDataUrlForDownload('blob:file:///does-not-exist')).rejects.toThrow('blob gone');
    fetchSpy.mockRestore();
  });
});
