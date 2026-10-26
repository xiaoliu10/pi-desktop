import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openLocalFile } from '../src/main/pi/open-local-file';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'open-local-file-'));
  mkdirSync(path.join(dir, 'Delivery.app', 'Contents', 'MacOS'), { recursive: true });
  mkdirSync(path.join(dir, 'design'), { recursive: true });
  symlinkSync(path.join(dir, 'Delivery.app'), path.join(dir, 'diagram.png'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function fixture(kind: 'file' | 'directory' | 'missing' = 'file') {
  const calls = { opened: [] as string[], revealed: [] as string[] };
  return {
    calls,
    deps: {
      statSync: (target: string) => {
        if (kind === 'missing') throw new Error('ENOENT');
        return { isDirectory: () => kind === 'directory', isFile: () => kind === 'file', path: target };
      },
      // mock 场景的路径都是虚拟的，realpath 按恒等解析（真实文件系统用例见下方真实 fs 测试）。
      realpathSync: (target: string) => target,
      openPath: async (target: string) => { calls.opened.push(target); return ''; },
      showItemInFolder: (target: string) => { calls.revealed.push(target); },
    },
  };
}

const realDeps = () => {
  const calls = { opened: [] as string[], revealed: [] as string[] };
  return {
    calls,
    deps: {
      openPath: async (target: string) => { calls.opened.push(target); return ''; },
      showItemInFolder: (target: string) => { calls.revealed.push(target); },
    },
  };
};

describe('openLocalFile', () => {
  it('rejects relative paths and NUL bytes', async () => {
    const f = fixture();
    await expect(openLocalFile('diagram.png', f.deps)).rejects.toThrow();
    await expect(openLocalFile('/tmp/a\0.png', f.deps)).rejects.toThrow();
    await expect(openLocalFile(42, f.deps)).rejects.toThrow();
    expect(f.calls.opened).toEqual([]);
    expect(f.calls.revealed).toEqual([]);
  });
  it('reports missing files instead of silently doing nothing', async () => {
    const f = fixture('missing');
    await expect(openLocalFile('/tmp/gone.png', f.deps)).rejects.toThrow('不存在');
  });
  it.each(['.png', '.pdf', '.html', '.md', '.svg', '.txt'])('opens document %s with the system default app', async (ext) => {
    const f = fixture();
    await expect(openLocalFile('/tmp/report' + ext, f.deps)).resolves.toEqual({ action: 'opened' });
    expect(f.calls.opened).toEqual(['/tmp/report' + ext]);
    expect(f.calls.revealed).toEqual([]);
  });
  it.each(['.command', '.exe', '.xyz', ''])('never executes %s payloads from chat text: reveals instead', async (ext) => {
    const f = fixture();
    await expect(openLocalFile('/tmp/payload' + ext, f.deps)).resolves.toEqual({ action: 'revealed' });
    expect(f.calls.opened).toEqual([]);
    expect(f.calls.revealed).toEqual(['/tmp/payload' + ext]);
  });
  it('opens ordinary directories in the file manager', async () => {
    const f = fixture('directory');
    await expect(openLocalFile('/tmp/delivery', f.deps)).resolves.toEqual({ action: 'opened' });
    expect(f.calls.opened).toEqual(['/tmp/delivery']);
  });
  it('surfaces shell.openPath failures to the caller', async () => {
    const f = fixture();
    f.deps.openPath = async () => 'Permission denied';
    await expect(openLocalFile('/tmp/report.pdf', f.deps)).rejects.toThrow('Permission denied');
  });

  // 安全门必须用真实文件系统验证：.app 在 macOS 上是目录，isDirectory() 短路会绕过黑名单。
  it('P0: a real .app bundle is a directory but is revealed, never launched', async () => {
    const f = realDeps();
    const result = await openLocalFile(path.join(dir, 'Delivery.app'), f.deps);
    expect(result).toEqual({ action: 'revealed' });
    expect(f.calls.opened).toEqual([]);
    expect(f.calls.revealed).toEqual([path.join(dir, 'Delivery.app')]);
  });
  it('defense in depth: a .png symlink pointing at an .app bundle is revealed', async () => {
    const f = realDeps();
    const result = await openLocalFile(path.join(dir, 'diagram.png'), f.deps);
    expect(result).toEqual({ action: 'revealed' });
    expect(f.calls.opened).toEqual([]);
    expect(f.calls.revealed).toEqual([path.join(dir, 'diagram.png')]);
  });
  it('a real directory opens in the file manager', async () => {
    const f = realDeps();
    const result = await openLocalFile(path.join(dir, 'design'), f.deps);
    expect(result).toEqual({ action: 'opened' });
    expect(f.calls.opened).toEqual([path.join(dir, 'design')]);
  });
});
