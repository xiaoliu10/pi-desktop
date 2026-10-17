import { describe, expect, it, vi } from 'vitest';

// image part → URL 的缓存/淘汰语义。直接 import ChatView 用的真实实现（不搞复刻，
// 避免「测试过而实现漂移」）。三条边界：命中不重建、失败退回 data URL、超限淘汰+revoke。
// 这组测试钉住「195MB base64 不能每拍重拼 / 不能无界常驻」这条性能契约。
// 注意：缓存是模块级共享的，id 各用例独立前缀。

const MAX = 256;

describe('imageDataUrl (real implementation)', () => {
  it('caches by part id: same id never re-encodes', async () => {
    const { imageDataUrl } = await import('../src/renderer/replica/chat/image-url');
    const spy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock');
    const p = { id: 'e1-image-0', kind: 'image' as const, data: btoa('x'.repeat(64)), mimeType: 'image/png' };
    expect(imageDataUrl(p)).toBe('blob:mock');
    expect(imageDataUrl(p)).toBe('blob:mock');
    expect(imageDataUrl({ ...p, id: 'e1-image-1', data: btoa('y') })).toBe('blob:mock');
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it('falls back to a data URL when blob creation fails', async () => {
    const { imageDataUrl } = await import('../src/renderer/replica/chat/image-url');
    const spy = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => { throw new Error('no blob'); });
    expect(imageDataUrl({ id: 'fb-1', kind: 'image' as const, data: btoa('x'), mimeType: 'image/png' })).toBe(`data:image/png;base64,${btoa('x')}`);
    spy.mockRestore();
  });

  it('evicts old entries and revokes their blob URLs past the cap', async () => {
    const { imageDataUrl } = await import('../src/renderer/replica/chat/image-url');
    const revoked: string[] = [];
    let n = 0;
    const spy = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:ev-${n++}`);
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(u => { revoked.push(u); });
    // 灌到远超上限：必须发生淘汰，且淘汰的是 blob: URL（位图随之释放）。条数不逐条精确
    // ——缓存跨用例共享，具体值随执行顺序漂；这里只钉「有淘汰、有 revoke、量级≈上限」。
    for (let i = 0; i < MAX * 2; i += 1) imageDataUrl({ id: `ev-p${i}`, kind: 'image' as const, data: btoa('x'), mimeType: 'image/png' });
    // 512 次插入触发约 3 轮淘汰（每轮 size>>1 条），总数多于一次淘汰量——断言范围放宽。
    expect(revoked.length).toBeGreaterThanOrEqual(MAX >> 1);
    // 前两用例留下的 blob:mock 也可能被一起淘汰，故只要求绝大多数是本轮 URL。
    expect(revoked.filter(u => u.startsWith('blob:ev-')).length).toBeGreaterThanOrEqual(MAX >> 1);
    spy.mockRestore();
    revokeSpy.mockRestore();
  });
});
