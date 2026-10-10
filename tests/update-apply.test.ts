import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupOldBundle, findAppBundle, swapAppBundle } from '../src/main/update-apply';

const execFileAsync = promisify(execFile);

// 换包流程用真 zip（ditto 打包，mac 自带）+ 假 bundle 结构，在临时目录全真演练。

const roots: string[] = [];
afterEach(() => { for (const d of roots.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-apply-'));
  roots.push(dir);
  return dir;
}

function makeBundle(parent: string, name: string, marker: string): string {
  const bundle = path.join(parent, name);
  fs.mkdirSync(path.join(bundle, 'Contents/MacOS'), { recursive: true });
  fs.writeFileSync(path.join(bundle, 'Contents/MacOS/PI Desktop'), marker);
  fs.writeFileSync(path.join(bundle, 'Contents/Info.plist'), `<plist>${marker}</plist>`);
  return bundle;
}

async function zipBundle(bundle: string, dest: string): Promise<void> {
  // --keepParent 让解压后是 <name>.app 目录本身（electron-builder mac zip 同构）。
  await execFileAsync('/usr/bin/ditto', ['-c', '-k', '--keepParent', bundle, dest]);
}

describe('findAppBundle', () => {
  it('finds the single .app and ignores other entries', () => {
    const dir = tmp();
    const bundle = makeBundle(dir, 'PI Desktop.app', 'v2');
    fs.writeFileSync(path.join(dir, 'README'), 'x');
    expect(findAppBundle(dir)).toBe(bundle);
  });
  it('returns undefined when the zip has no .app', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'loose-file'), 'x');
    expect(findAppBundle(dir)).toBeUndefined();
  });
});

describe('swapAppBundle', () => {
  it('replaces the running bundle in place and removes the old one', async () => {
    const parent = tmp();
    const bundle = makeBundle(parent, 'PI Desktop.app', 'v1');
    const staging = tmp();
    const newBundle = makeBundle(staging, 'PI Desktop.app', 'v2');
    const zipPath = path.join(staging, 'update.zip');
    await zipBundle(newBundle, zipPath);

    const result = await swapAppBundle({ zipPath, bundlePath: bundle });

    expect(result).toBe(bundle);
    expect(fs.readFileSync(path.join(bundle, 'Contents/MacOS/PI Desktop'), 'utf8')).toBe('v2');
    expect(fs.existsSync(bundle + '.update-old')).toBe(false);
  });

  it('rejects a zip without a bundle before touching the running app', async () => {
    const parent = tmp();
    const bundle = makeBundle(parent, 'PI Desktop.app', 'v1');
    const staging = tmp();
    const zipPath = path.join(staging, 'bad.zip');
    fs.writeFileSync(path.join(staging, 'loose.txt'), 'no app here');
    await execFileAsync('/usr/bin/ditto', ['-c', '-k', staging, zipPath]);

    await expect(swapAppBundle({ zipPath, bundlePath: bundle })).rejects.toThrow(/没有 \.app/);
    // 旧包原封不动
    expect(fs.readFileSync(path.join(bundle, 'Contents/MacOS/PI Desktop'), 'utf8')).toBe('v1');
    expect(fs.existsSync(bundle + '.update-old')).toBe(false);
  });

  it('rolls the old bundle back when moving the new one into place fails', async () => {
    const parent = tmp();
    const bundle = makeBundle(parent, 'PI Desktop.app', 'v1');
    const staging = tmp();
    const newBundle = makeBundle(staging, 'PI Desktop.app', 'v2');
    const zipPath = path.join(staging, 'update.zip');
    await zipBundle(newBundle, zipPath);

    // 拦截第二次 rename（新包就位）注入失败，第一次（旧包挪走）与回滚调用放行。
    const original = fs.renameSync.bind(fs);
    let calls = 0;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      calls++;
      if (calls === 2) throw Object.assign(new Error('ENOTEMPTY (injected)'), { code: 'ENOTEMPTY' });
      return original(from, to);
    }) as typeof fs.renameSync);

    try {
      await expect(swapAppBundle({ zipPath, bundlePath: bundle })).rejects.toThrow('ENOTEMPTY');
    } finally {
      spy.mockRestore();
    }
    // 回滚：旧包内容完整还原，暂存目录已清
    expect(fs.readFileSync(path.join(bundle, 'Contents/MacOS/PI Desktop'), 'utf8')).toBe('v1');
    expect(fs.existsSync(bundle + '.update-old')).toBe(false);
    expect(fs.readdirSync(parent).filter(n => n.startsWith('.pi-update-work-'))).toEqual([]);
  }, 20_000);

  it('cleans up a stale .update-old residue on startup', async () => {
    const parent = tmp();
    const bundle = makeBundle(parent, 'PI Desktop.app', 'v1');
    const residue = bundle + '.update-old';
    makeBundle(residue, 'PI Desktop.app', 'v0');
    cleanupOldBundle(bundle);
    expect(fs.existsSync(residue)).toBe(false);
    expect(fs.existsSync(bundle)).toBe(true);
  });
});
