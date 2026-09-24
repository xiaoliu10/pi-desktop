import { describe, expect, it } from 'vitest';
import { imageDataUrl, imageFileName } from '../src/main/pi/image-file';

const PNG_PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('图片下载的数据校验', () => {
  it('解码合法 data URL 并保留 mime', () => {
    const { bytes, mime } = imageDataUrl(PNG_PIXEL);
    expect(mime).toBe('image/png');
    expect(bytes.length).toBeGreaterThan(0);
    expect(imageDataUrl('data:image/jpeg;base64,QUJD').mime).toBe('image/jpeg');
  });
  it('拒绝非图片/非 base64/超限数据', () => {
    expect(() => imageDataUrl('data:text/html;base64,PGI+')).toThrow('图片数据无效');
    expect(() => imageDataUrl('not a data url')).toThrow('图片数据无效');
    expect(() => imageDataUrl(undefined)).toThrow('图片数据无效');
    expect(() => imageDataUrl('data:image/png;base64,QUJD---------')).toThrow('图片数据无效');
    const huge = 'data:image/png;base64,' + 'A'.repeat(14 * 1024 * 1024); // 解码 ≈10.5 MiB，超限
    expect(() => imageDataUrl(huge)).toThrow('10 MiB');
  });
  it('文件名剥离非法字符并在缺扩展名时按 mime 补齐', () => {
    expect(imageFileName('截图 1.png', 'image/png')).toBe('截图 1.png');
    expect(imageFileName('截图:1', 'image/png')).toBe('截图_1.png');
    expect(imageFileName('shot', 'image/jpeg')).toBe('shot.jpg');
    expect(imageFileName('', 'image/webp')).toBe('图片.webp');
    expect(imageFileName('a'.repeat(120), 'image/png')).toHaveLength(104); // 100 + '.png'
  });
});
