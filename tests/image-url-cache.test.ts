import { describe, expect, it, vi } from 'vitest';

// image part → URL 的持有/释放/淘汰语义。直接 import ChatView 用的真实实现（不搞复刻，
// 避免「测试过而实现漂移」）。四条边界：命中不重编码、挂载期引用计数、淘汰推迟到
// 最后一票归还才 revoke（use-after-revoke 会裂图且 memo 化的 turn 不自愈）、
// data 指纹挡住「同 id 不同 data」的串图（无 id entry 走 entry-N 兜底会跨刷新串位）。
// 注意：缓存是模块级共享的，各用例 id/数据独立前缀。

type ImgPart = Extract<import('../src/renderer/replica/contracts').MessagePart, { kind: 'image' }>;

describe('image URL lifecycle (real implementation)', () => {
  it('caches by id+data fingerprint: same id never re-encodes', async () => {
    const { acquireImageUrl, releaseImageUrl, __resetImageUrlCacheForTest } = await import('../src/renderer/replica/chat/image-url');
    __resetImageUrlCacheForTest();
    const spy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock');
    const p: ImgPart = { id: 'e1-image-0', kind: 'image', data: btoa('x'.repeat(64)), mimeType: 'image/png' };
    expect(acquireImageUrl(p)).toBe('blob:mock');
    expect(acquireImageUrl(p)).toBe('blob:mock');
    releaseImageUrl(p); // 还有一票持有，不淘汰也不 revoke
    expect(acquireImageUrl(p)).toBe('blob:mock');
    expect(spy).toHaveBeenCalledTimes(1);
    releaseImageUrl(p);
    spy.mockRestore();
  });

  it('defers revoke until the last holder releases (no use-after-revoke)', async () => {
    const { acquireImageUrl, releaseImageUrl, __resetImageUrlCacheForTest } = await import('../src/renderer/replica/chat/image-url');
    __resetImageUrlCacheForTest();
    const revoked: string[] = [];
    const spy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:held');
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(u => { revoked.push(u); });
    const p: ImgPart = { id: 'held-1', kind: 'image', data: btoa('x'), mimeType: 'image/png' };
    const first = acquireImageUrl(p);
    const second = acquireImageUrl(p);
    expect(first).toBe(second);
    // 灌满缓存触发淘汰：held-1 仍有 2 票持有 → 不得 revoke（正在显示的 <img> 会裂图）。
    for (let i = 0; i < 300; i += 1) acquireImageUrl({ id: `fill-${i}`, kind: 'image', data: btoa('y'), mimeType: 'image/png' });
    expect(revoked).not.toContain('blob:held');
    releaseImageUrl(p);
    expect(revoked).not.toContain('blob:held');
    releaseImageUrl(p); // 最后一票：立即释放
    expect(revoked).toContain('blob:held');
    spy.mockRestore();
    revokeSpy.mockRestore();
  });

  it('revokes entries with no holders at eviction time', async () => {
    const { acquireImageUrl, releaseImageUrl, __resetImageUrlCacheForTest } = await import('../src/renderer/replica/chat/image-url');
    __resetImageUrlCacheForTest();
    const revoked: string[] = [];
    let n = 0;
    const spy = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:gone-${n++}`);
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(u => { revoked.push(u); });
    // acquire 后立即 release：这些条目无持有者，被淘汰时应当场 revoke（不等任何人）。
    for (let i = 0; i < 300; i += 1) {
      const p = { id: `gone-${i}`, kind: 'image' as const, data: btoa('x'), mimeType: 'image/png' };
      acquireImageUrl(p);
      releaseImageUrl(p);
    }
    expect(revoked.length).toBeGreaterThan(0);
    expect(revoked.every(u => u.startsWith('blob:gone-'))).toBe(true);
    spy.mockRestore();
    revokeSpy.mockRestore();
  });

  it('distinguishes same id with different data (entry-N fallback ids can collide)', async () => {
    const { acquireImageUrl, releaseImageUrl, __resetImageUrlCacheForTest } = await import('../src/renderer/replica/chat/image-url');
    __resetImageUrlCacheForTest();
    const spy = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:${Math.random()}`);
    const oldData = btoa('a'.repeat(1000));
    const newData = btoa('b'.repeat(2000));
    const a = acquireImageUrl({ id: 'entry-3-image-0', kind: 'image', data: oldData, mimeType: 'image/png' });
    releaseImageUrl({ id: 'entry-3-image-0', kind: 'image', data: oldData, mimeType: 'image/png' });
    const b = acquireImageUrl({ id: 'entry-3-image-0', kind: 'image', data: newData, mimeType: 'image/png' });
    expect(b).not.toBe(a); // 指纹不同 ⇒ 不复用旧 URL，不会串图
    releaseImageUrl({ id: 'entry-3-image-0', kind: 'image', data: newData, mimeType: 'image/png' });
    spy.mockRestore();
  });

  it('falls back to a data URL when blob creation fails', async () => {
    const { acquireImageUrl, __resetImageUrlCacheForTest } = await import('../src/renderer/replica/chat/image-url');
    __resetImageUrlCacheForTest();
    const spy = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => { throw new Error('no blob'); });
    const data = btoa('x');
    expect(acquireImageUrl({ id: 'fb-1', kind: 'image', data, mimeType: 'image/png' })).toBe(`data:image/png;base64,${data}`);
    spy.mockRestore();
  });
});
