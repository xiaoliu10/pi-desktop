import { describe, expect, it } from 'vitest';
import { acquireImageUrl, releaseImageUrl } from '../src/renderer/replica/chat/image-url';

// 真实会话 base64 的解码契约（Node 侧）：pi 序列化的大块（83KB）必须走 blob，
// 不得静默降级 data URL（降级=每张图常驻两份 + 每拍重拼，是「预览看不到+越用越卡」的根因）。
describe('image encode on real session data', () => {
  it('decodes a real 83KB block', async () => {
    // 自包含的合法 base64（不依赖 /tmp 外部数据）：足够大的块才压得出 atob 的边界问题
    const fs = await import('node:crypto');
    const data = Buffer.from(fs.randomBytes(60_000)).toString('base64'); // 80KB 合法块
    expect(data.length).toBeGreaterThan(1000);
    const url = acquireImageUrl({ kind: 'image', id: 'real', data, mimeType: 'image/png' });
    expect(url.startsWith('blob:')).toBe(true);
    releaseImageUrl({ kind: 'image', id: 'real', data, mimeType: 'image/png' });
  });
  it('tolerates whitespace-wrapped blocks', async () => {
    const fs = await import('node:crypto');
    const data = Buffer.from(fs.randomBytes(60_000)).toString('base64');
    const wrapped = (data.match(/.{1,76}/g) ?? []).join('\n');
    const url = acquireImageUrl({ kind: 'image', id: 'ws', data: wrapped, mimeType: 'image/png' });
    expect(url.startsWith('blob:')).toBe(true);
    releaseImageUrl({ kind: 'image', id: 'ws', data: wrapped, mimeType: 'image/png' });
  });
});
