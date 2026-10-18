import { describe, expect, it } from 'vitest';
import { acquireImageUrl, releaseImageUrl } from '../src/renderer/replica/chat/image-url';

// 真实会话 base64 的解码契约（Node 侧）：pi 序列化的大块（83KB）必须走 blob，
// 不得静默降级 data URL（降级=每张图常驻两份 + 每拍重拼，是「预览看不到+越用越卡」的根因）。
describe('image encode on real session data', () => {
  it('decodes a real 83KB block', async () => {
    const fs = await import('node:fs');
    const data = fs.readFileSync('/tmp/real-b64.txt', 'utf8').trim();
    expect(data.length).toBeGreaterThan(1000);
    const url = acquireImageUrl({ kind: 'image', id: 'real', data, mimeType: 'image/png' });
    expect(url.startsWith('blob:')).toBe(true);
    releaseImageUrl({ kind: 'image', id: 'real', data, mimeType: 'image/png' });
  });
  it('tolerates whitespace-wrapped blocks', async () => {
    const fs = await import('node:fs');
    const data = fs.readFileSync('/tmp/real-b64.txt', 'utf8').trim();
    const wrapped = (data.match(/.{1,76}/g) ?? []).join('\n');
    const url = acquireImageUrl({ kind: 'image', id: 'ws', data: wrapped, mimeType: 'image/png' });
    expect(url.startsWith('blob:')).toBe(true);
    releaseImageUrl({ kind: 'image', id: 'ws', data: wrapped, mimeType: 'image/png' });
  });
});
