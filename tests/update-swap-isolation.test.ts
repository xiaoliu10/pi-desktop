// 换包安全性回归：解压必须发生在独立暂存目录，任何解压失败都不能碰正在用的旧包。
// 背景（2026-11-08 实机事故）：swapAppBundle 直接把 zip 解到 bundle 的父目录。
// ditto 遇到「同名路径先是文件、随后又要当目录」的损坏/伪造 zip 时会把父路径当成
// 待删目录递归删除（ENOTDIR rmdir 报错），于是旧 PI Desktop.app 被删掉大半
// （实测只剩 Contents/Resources，495MB），应用虽仍能运行但磁盘上已不可再用。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupSwapResidue, swapAppBundle, SWAP_STAGING_DIRNAME } from '../src/main/update-apply';

const roots: string[] = [];
afterEach(() => { for (const d of roots.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-swap-'));
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

/** 构造最小 zip（stored 之外的 deflate 流，ditto 可直接解）；entries 按顺序写入。 */
function buildZip(dest: string, entries: Array<[string, string]>): void {
  const body: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const raw = Buffer.from(data);
    const compressed = zlib.deflateRawSync(raw);
    const nameBuf = Buffer.from(name);
    const crc = zlib.crc32(raw) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    body.push(local, nameBuf, compressed);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(0x0314, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(compressed.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + compressed.length;
  }
  const cdBuf = Buffer.concat(central);
  const bodyBuf = Buffer.concat(body);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(bodyBuf.length, 16);
  fs.writeFileSync(dest, Buffer.concat([bodyBuf, cdBuf, eocd]));
}

function bundleDigest(bundle: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const st = fs.lstatSync(full);
      if (st.isDirectory()) { out.push(`${path.relative(bundle, full)}/`); walk(full); }
      else out.push(`${path.relative(bundle, full)}=${fs.readFileSync(full, 'utf8')}`);
    }
  };
  walk(bundle);
  return out;
}

/**
 * 真实事故形态（2026-11-08 本机取证）：
 * 旧包目录里有 zip 不包含的旧条目（.update-old 残留 = 上一版 app，比现版多 5 个资源项），
 * 其中某个旧条目是「符号链接指向文件」，而同名新条目在 zip 里是普通文件 → ditto 报
 * `rmdir .../app.asar: ENOTDIR`，并沿目录链一路删除，把旧包内容删到只剩 Resources。
 */
function makeBundleWithStaleSymlink(parent: string, name: string, marker: string): { bundle: string; staleDir: string } {
  const bundle = path.join(parent, name);
  fs.mkdirSync(path.join(bundle, 'Contents/MacOS'), { recursive: true });
  fs.mkdirSync(path.join(bundle, 'Contents/Resources'), { recursive: true });
  fs.writeFileSync(path.join(bundle, 'Contents/MacOS/PI Desktop'), marker);
  fs.writeFileSync(path.join(bundle, 'Contents/Info.plist'), `<plist>${marker}</plist>`);
  const target = path.join(parent, 'stale-target.bin');
  fs.writeFileSync(target, 'stale-target');
  // 旧包里 zip 没有的条目：一个旧目录 + 一个符号链接（zip 里同名条目是普通文件）。
  fs.mkdirSync(path.join(bundle, 'Contents/StaleDir'));
  fs.writeFileSync(path.join(bundle, 'Contents/StaleDir/old.txt'), 'stale');
  fs.symlinkSync(target, path.join(bundle, 'Contents/Resources/app.asar'));
  return { bundle, staleDir: path.join(bundle, 'Contents/StaleDir') };
}

describe('swapAppBundle 解压隔离', () => {
  it('解压错误（旧包里的符号链接同名条目 → rmdir ENOTDIR）不得删除旧包内容', async () => {
    const parent = tmp();
    const { bundle } = makeBundleWithStaleSymlink(parent, 'PI Desktop.app', 'v1');
    const before = bundleDigest(bundle);
    const zipPath = path.join(tmp(), 'conflict.zip');
    // 解压内容与旧包布局不完全一致（zip 里 app.asar 是普通文件），
    // 旧实现直接解到 parent，任何解压错误都在旧包目录里就地发生。
    buildZip(zipPath, [
      ['PI Desktop.app/Contents/Info.plist', '<plist>v2</plist>'],
      ['PI Desktop.app/Contents/Resources/app.asar', 'v2-asar'],
      ['PI Desktop.app/Contents/StaleDir', 'v2-dir-as-file'],
    ]);

    await expect(swapAppBundle({ zipPath, bundlePath: bundle })).rejects.toThrow(/解压|不完整/);
    expect(bundleDigest(bundle)).toEqual(before);
    expect(fs.existsSync(bundle + '.update-old')).toBe(false);
    expect(fs.readdirSync(parent)).toEqual(['PI Desktop.app', 'stale-target.bin']);
  }, 30_000);

  it('解压不完整（缺 Contents/MacOS 可执行文件）时拒绝换包并保留旧包', async () => {
    const parent = tmp();
    const bundle = makeBundle(parent, 'PI Desktop.app', 'v1');
    const before = bundleDigest(bundle);
    const zipPath = path.join(tmp(), 'partial.zip');
    buildZip(zipPath, [
      ['PI Desktop.app/Contents/Info.plist', '<plist>v2</plist>'],
      ['PI Desktop.app/Contents/Resources/app.asar', 'asar'],
    ]);

    await expect(swapAppBundle({ zipPath, bundlePath: bundle })).rejects.toThrow(/不完整|缺少/);
    expect(bundleDigest(bundle)).toEqual(before);
    expect(fs.existsSync(bundle + '.update-old')).toBe(false);
  }, 30_000);

  it('解压先在独立暂存目录完成：暂存目录不建在旧包目录内', async () => {
    const parent = tmp();
    const bundle = makeBundle(parent, 'PI Desktop.app', 'v1');
    const zipPath = path.join(tmp(), 'ok.zip');
    buildZip(zipPath, [
      ['PI Desktop.app/Contents/MacOS/PI Desktop', 'v2'],
      ['PI Desktop.app/Contents/Info.plist', '<plist>v2</plist>'],
    ]);
    let stagingSeen: string[] | undefined;

    const result = await swapAppBundle({ zipPath, bundlePath: bundle, onStaged: dir => { stagingSeen = [dir, ...fs.readdirSync(parent)]; } });

    expect(result).toBe(bundle);
    expect(fs.readFileSync(path.join(bundle, 'Contents/MacOS/PI Desktop'), 'utf8')).toBe('v2');
    expect(stagingSeen).toBeDefined();
    const [staging, listing] = stagingSeen!;
    // 暂存在旧包之外的临时目录完成，且没有在旧包里面留任何东西。
    expect(staging.startsWith(path.dirname(parent))).toBe(true);
    expect(staging.startsWith(parent)).toBe(false);
    expect(listing).toContain('PI Desktop.app');
    expect(fs.readdirSync(parent)).toEqual(['PI Desktop.app']);
  }, 30_000);

  it('旧暂存残留被启动清理移除（换包进程崩溃后的兜底）', async () => {
    const parent = tmp();
    const bundle = makeBundle(parent, 'PI Desktop.app', 'v1');
    const staging = path.join(parent, SWAP_STAGING_DIRNAME);
    fs.mkdirSync(path.join(staging, 'PI Desktop.app/Contents/MacOS'), { recursive: true });
    fs.writeFileSync(path.join(staging, 'PI Desktop.app/Contents/MacOS/PI Desktop'), 'half');

    cleanupSwapResidue(bundle);

    expect(fs.existsSync(staging)).toBe(false);
    expect(fs.existsSync(path.join(bundle, 'Contents/MacOS/PI Desktop'))).toBe(true);
  });
});
