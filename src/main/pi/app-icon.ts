import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * macOS 应用图标提取：Info.plist → Resources/*.icns → sips 转 PNG dataURL。
 * 背景：app.getFileIcon 在本机（macOS 26 + Electron 33）对 .app 一律返回同一张
 * 通用占位图（1634 字节），不能用于展示；直接读 bundle 内的 icns 是可靠来源。
 */
const iconCache = new Map<string, string>();

function icnsToPngDataUrl(icns: string): Promise<string | undefined> {
  return new Promise(resolve => {
    const out = path.join(os.tmpdir(), `pi-app-icon-${createHash('sha1').update(icns).digest('hex').slice(0, 12)}.png`);
    // -Z 限定最长边：UI 只画 16px，避免把 512px 的 icns 整张编码进 dataURL。
    const child = spawn('/usr/bin/sips', ['-s', 'format', 'png', '-Z', '32', icns, '--out', out], { stdio: 'ignore' });
    child.once('error', () => resolve(undefined));
    child.once('exit', code => {
      try {
        if (code !== 0 || !fs.existsSync(out)) return resolve(undefined);
        const png = fs.readFileSync(out);
        resolve(png.length > 64 ? `data:image/png;base64,${png.toString('base64')}` : undefined);
      } catch { resolve(undefined); }
    });
  });
}

/** 提取 .app 的真实图标；任何一步失败返回 undefined（调用方回退 Electron API 或文字图标）。 */
export async function bundleIcon(appPath: string): Promise<string | undefined> {
  const cached = iconCache.get(appPath);
  if (cached !== undefined) return cached;
  let result: string | undefined;
  try {
    const plist = path.join(appPath, 'Contents', 'Info.plist');
    if (fs.existsSync(plist)) {
      const meta = JSON.parse(spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8', maxBuffer: 1 << 20 }).stdout ?? '{}') as Record<string, unknown>;
      const raw = String(meta.CFBundleIconFile || meta.CFBundleIconName || '');
      if (raw) {
        const name = raw.replace(/\.icns$/i, '');
        const icns = path.join(appPath, 'Contents', 'Resources', `${name}.icns`);
        if (fs.existsSync(icns)) result = await icnsToPngDataUrl(icns);
      }
    }
  } catch { result = undefined; }
  if (result) iconCache.set(appPath, result);
  return result;
}
