import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isNewerVersion, startUpdateChecker, type UpdateStatus } from '../src/main/update-check';

// 更新检查三块：版本比较（纯函数）、release 拉取解析（mock fetch）、调度（fake timers）。

describe('isNewerVersion', () => {
  it.each([
    ['v0.1.16', '0.1.15', true],
    ['0.2.0', '0.1.15', true],
    ['0.1.15', '0.1.15', false],
    ['0.1.14', '0.1.15', false],
    ['v0.1.15', '0.1.15', false],
    ['1.0.0', '0.9.9', true],
    // 同号：正式版 > 预发布
    ['0.1.15', '0.1.15-beta.1', true],
    ['0.1.15-beta.1', '0.1.15', false],
    ['0.1.16-beta.1', '0.1.15', true],
    // 预发布段数值比较（字符串比较会误判 '9' > '10'）
    ['0.1.15-beta.10', '0.1.15-beta.9', true],
    ['0.1.15-beta.9', '0.1.15-beta.10', false],
    ['0.1.15-beta.2', '0.1.15-beta.1.5', true],
  ])('isNewerVersion(%j, %j) = %j', (latest, current, expected) => {
    expect(isNewerVersion(latest, current)).toBe(expected);
  });
  it.each(['', 'abc', '1.2', 'v1', '0.1.15-beta..1'])('rejects unparseable latest %j', latest => {
    expect(isNewerVersion(latest, '0.1.15')).toBe(false);
  });
  it.each(['', 'abc', 'dev', '0.1'])('rejects unparseable current %j (fail closed)', current => {
    expect(isNewerVersion('9.9.9', current)).toBe(false);
  });
});

const releaseJson = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  html_url: `https://github.com/xiaoliu10/pi-desktop/releases/tag/${tag}`,
  draft: false,
  prerelease: false,
  ...extra,
});
const okResponse = (body: unknown) => ({ ok: true, json: async () => body });

describe('startUpdateChecker', () => {
  const statuses: UpdateStatus[] = [];
  const onStatus = (s: UpdateStatus) => statuses.push(s);
  beforeEach(() => { statuses.length = 0; });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('reports available with normalized tag and url when a newer release exists', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(releaseJson('v0.1.16'))));
    const checker = startUpdateChecker({ currentVersion: '0.1.15', onStatus, initialDelayMs: 999_999 });
    const status = await checker.checkNow();
    expect(status).toMatchObject({ available: true, current: '0.1.15', latest: '0.1.16', url: 'https://github.com/xiaoliu10/pi-desktop/releases/tag/v0.1.16' });
    expect(statuses).toHaveLength(1);
    checker.dispose();
  });

  it('reports not-available for same or older releases but still publishes status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(releaseJson('v0.1.15'))));
    const checker = startUpdateChecker({ currentVersion: '0.1.15', onStatus, initialDelayMs: 999_999 });
    const status = await checker.checkNow();
    expect(status).toMatchObject({ available: false, latest: '0.1.15' });
    checker.dispose();
  });

  it.each([
    ['http 404', async () => ({ ok: false, status: 404 })],
    ['http 403 rate-limit', async () => ({ ok: false, status: 403 })],
    ['malformed json', async () => okResponse({ boom: true })],
    ['draft release', async () => okResponse(releaseJson('v9.9.9', { draft: true }))],
    ['prerelease', async () => okResponse(releaseJson('v9.9.9', { prerelease: true }))],
    ['foreign html_url', async () => okResponse({ ...releaseJson('v9.9.9'), html_url: 'https://evil.example/x' })],
    ['network error', async () => { throw new Error('offline'); }],
  ])('degrades silently on %s', async (_name, fetchImpl) => {
    vi.stubGlobal('fetch', vi.fn(fetchImpl as () => Promise<unknown>));
    const checker = startUpdateChecker({ currentVersion: '0.1.15', onStatus, initialDelayMs: 999_999 });
    const status = await checker.checkNow();
    expect(status).toMatchObject({ available: false, current: '0.1.15' });
    expect(status.latest).toBeUndefined();
    expect(status.url).toBeUndefined();
    checker.dispose();
  });

  it('checks after the initial delay and repeats on the interval; dispose stops the loop', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => okResponse(releaseJson('v0.2.0')));
    vi.stubGlobal('fetch', fetchMock);
    const checker = startUpdateChecker({ currentVersion: '0.1.15', onStatus, initialDelayMs: 10_000, intervalMs: 60_000 });
    // 初始延迟前不查
    await vi.advanceTimersByTimeAsync(9_999);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // 周期复查
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(statuses).toHaveLength(2);
    checker.dispose();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(statuses).toHaveLength(2); // dispose 后不再推送
  });

  it('manual checkNow does not double-schedule the periodic loop', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => okResponse(releaseJson('v0.2.0')));
    vi.stubGlobal('fetch', fetchMock);
    const checker = startUpdateChecker({ currentVersion: '0.1.15', onStatus, initialDelayMs: 10_000, intervalMs: 60_000 });
    await checker.checkNow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000); // 初始调度照常触发
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(3); // 仍是单循环，没有因手动 checkNow 叠加
    checker.dispose();
  });

  it('status() returns the last check result; undefined before the first one', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(releaseJson('v0.1.16'))));
    const checker = startUpdateChecker({ currentVersion: '0.1.15', onStatus, initialDelayMs: 999_999 });
    expect(checker.status()).toBeUndefined();
    await checker.checkNow();
    expect(checker.status()?.latest).toBe('0.1.16');
    checker.dispose();
  });

  it('setApplyState survives later checkNow rebuilds (no re-download after ready)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(releaseJson('v0.1.16'))));
    const checker = startUpdateChecker({ currentVersion: '0.1.15', onStatus, initialDelayMs: 999_999 });
    await checker.checkNow();
    checker.setApplyState('downloading', 40);
    expect(checker.status()).toMatchObject({ state: 'downloading', progress: 40 });
    checker.setApplyState('ready');
    // 6h 周期检查或手动 Check for Updates 重建结果时，apply 状态必须保留
    await checker.checkNow();
    expect(statuses.at(-1)).toMatchObject({ available: true, state: 'ready', latest: '0.1.16' });
    checker.dispose();
  });

  it('picks the arm64 zip asset for auto-apply and keeps state idle', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({
      ...releaseJson('v0.1.16'),
      assets: [
        { name: 'PI.Desktop-0.1.16-arm64.dmg', browser_download_url: 'https://github.com/xiaoliu10/pi-desktop/releases/download/v0.1.16/PI.Desktop-0.1.16-arm64.dmg', size: 10 },
        { name: 'PI.Desktop-0.1.16-arm64.zip', browser_download_url: 'https://github.com/xiaoliu10/pi-desktop/releases/download/v0.1.16/PI.Desktop-0.1.16-arm64.zip', size: 222 },
        { name: 'PI.Desktop.Setup.0.1.16.exe', browser_download_url: 'https://github.com/xiaoliu10/pi-desktop/releases/download/v0.1.16/PI.Desktop.Setup.0.1.16.exe', size: 30 },
      ],
    })));
    const checker = startUpdateChecker({ currentVersion: '0.1.15', onStatus, initialDelayMs: 999_999 });
    const status = await checker.checkNow();
    expect(status.zipUrl).toBe('https://github.com/xiaoliu10/pi-desktop/releases/download/v0.1.16/PI.Desktop-0.1.16-arm64.zip');
    expect(status.zipSize).toBe(222);
    expect(status.state).toBe('idle');
    checker.dispose();
  });

  it.each([
    ['no zip asset', [{ name: 'only.dmg', browser_download_url: 'https://github.com/x/only.dmg', size: 1 }]],
    ['x64-only zip', [{ name: 'PI.Desktop-0.1.16-x64.zip', browser_download_url: 'https://github.com/x/pi.zip', size: 1 }]],
    ['foreign url zip', [{ name: 'PI.Desktop-0.1.16-arm64.zip', browser_download_url: 'https://evil.example/pi.zip', size: 1 }]],
    ['assets missing', undefined],
  ])('degrades to no zipUrl on %s', async (_name, assets) => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ ...releaseJson('v0.1.16'), assets })));
    const checker = startUpdateChecker({ currentVersion: '0.1.15', onStatus, initialDelayMs: 999_999 });
    const status = await checker.checkNow();
    expect(status.available).toBe(true);
    expect(status.zipUrl).toBeUndefined();
    expect(status.zipSize).toBeUndefined();
    checker.dispose();
  });
});

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { downloadUpdateZip } from '../src/main/update-check';

describe('downloadUpdateZip', () => {
  const bytes = Buffer.from('fake zip payload for update download');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  let dir = '';
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-dl-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const zipResponse = () => new Response(bytes, { headers: { 'content-length': String(bytes.length) } });

  it('downloads with progress and passes size and digest checks', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => zipResponse()));
    const dest = path.join(dir, 'update.zip');
    const progress: number[] = [];
    await downloadUpdateZip('https://github.com/x/pi.zip', dest, p => progress.push(p), { size: bytes.length, digest: `sha256:${sha256}` });
    expect(fs.readFileSync(dest)).toEqual(bytes);
    expect(progress.at(-1)).toBe(100);
  });

  it('rejects when the digest does not match (tampered/corrupted payload)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => zipResponse()));
    await expect(downloadUpdateZip('https://github.com/x/pi.zip', path.join(dir, 'update.zip'), () => {}, { digest: `sha256:${'0'.repeat(64)}` })).rejects.toThrow(/sha256 不符/);
  });

  it('rejects when the size does not match the release asset', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => zipResponse()));
    // size 不符会先被「下载不完整」（received ≠ total）接住，两条校验语义等价
    await expect(downloadUpdateZip('https://github.com/x/pi.zip', path.join(dir, 'update.zip'), () => {}, { size: bytes.length + 1 })).rejects.toThrow(/不完整|不符/);
  });
});
