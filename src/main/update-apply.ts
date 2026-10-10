/**
 * 更新包应用（macOS）：ditto 解压 → 旧包挪走 → 新包就位 → 删旧包。
 * 故意不 import electron——bundle 路径由调用方传入，本模块纯 fs/exec 可单测。
 * 换包安全：「新包就位」失败时把旧包挪回来（回滚），保证应用始终可用；
 * 挪走正在运行的旧 bundle 是安全的（Mach-O 已映射进内核，inode 存活）。
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 旧 bundle 挪走的暂存名（启动清理的目标）。 */
export const OLD_BUNDLE_SUFFIX = '.update-old';

/** 在解压目录里找 .app bundle（预期只有一个；找不到返回 undefined）。 */
export function findAppBundle(dir: string): string | undefined {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (name.endsWith('.app') && fs.statSync(full).isDirectory()) return full;
  }
  return undefined;
}

/**
 * 应用更新包：ditto 解压 zip（保留签名/扩展属性/metadata）→ 新旧换位。
 * 返回就位后的新 bundle 路径（与 bundlePath 同位同名）。workDir 供测试注入；
 * 默认在 bundle 同目录建临时工作目录（保证 rename 同卷，跨卷 rename 会 EXDEV）。
 */
export async function swapAppBundle(opts: { zipPath: string; bundlePath: string; workDir?: string }): Promise<string> {
  const bundle = opts.bundlePath;
  const parent = path.dirname(bundle);
  fs.mkdirSync(parent, { recursive: true });
  const work = opts.workDir ?? fs.mkdtempSync(path.join(parent, '.pi-update-work-'));
  const oldPath = bundle + OLD_BUNDLE_SUFFIX;
  try {
    await execFileAsync('/usr/bin/ditto', ['-x', '-k', opts.zipPath, work]);
    const newApp = findAppBundle(work);
    if (!newApp) throw new Error('更新包里没有 .app bundle（下载可能不完整）');
    fs.rmSync(oldPath, { recursive: true, force: true });
    fs.renameSync(bundle, oldPath);
    try {
      fs.renameSync(newApp, bundle);
    } catch (e) {
      // 回滚：新包就位失败必须还原旧包，应用不能坏在半路。
      try { fs.renameSync(oldPath, bundle); } catch { /* 回滚也失败时旧包留在 .update-old，下次启动清理后可手动恢复 */ }
      throw e;
    }
    fs.rmSync(oldPath, { recursive: true, force: true });
    return bundle;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** 启动清理：上次更新中断残留的旧 bundle（正常换包流程已自删，这是兜底）。 */
export function cleanupOldBundle(bundlePath: string): void {
  try { fs.rmSync(bundlePath + OLD_BUNDLE_SUFFIX, { recursive: true, force: true }); } catch { /* best effort */ }
}
