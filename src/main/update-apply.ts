/**
 * 更新包应用（macOS）：ditto 解压 → 旧包挪走 → 新包就位 → 删旧包。
 * 故意不 import electron——bundle 路径由调用方传入，本模块纯 fs/exec 可单测。
 *
 * 换包安全（2026-11-08 实机事故后重写）：
 * - **解压必须在独立暂存目录完成**，绝不能解到 bundle 的父目录。旧实现直接把 zip
 *   解到 `dirname(bundle)`，ditto 的目录合并会在缺少可写权限、校验失败、磁盘满、
 *   压缩流异常等情况下就地失败，期间已删除/半写入的内容就在正在使用的旧包里，
 *   并且还会留下无法用 `rmdir` 清掉的半成品（实机：`rmdir .../app.asar: ENOTDIR`，
 *   旧包被删到只剩 `Contents/Resources`，从 758MB 掉到 493MB）。
 * - 解压后先校验新包结构（Info.plist + Contents/MacOS 可执行文件），缺任一即判为
 *   不完整包，**不换包**，旧包原样保留。
 * - 换位失败回滚旧包；旧包挪走期间是原子的 rename，失败可完整还原。
 * - 暂存目录崩溃残留由 `cleanupSwapResidue` 在启动时清掉。
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 旧 bundle 挪走的暂存名（启动清理的目标）。 */
export const OLD_BUNDLE_SUFFIX = '.update-old';

/** 遗留的旧暂存目录名（历史版本曾把工作目录建在 bundle 父目录里）。 */
export const SWAP_STAGING_DIRNAME = '.pi-update-work-';

/** 在解压目录里找 .app bundle（预期只有一个；找不到返回 undefined）。 */
export function findAppBundle(dir: string): string | undefined {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (name.endsWith('.app') && fs.statSync(full).isDirectory()) return full;
  }
  return undefined;
}

/**
 * 新包结构完整性校验：mac app 至少要有 Info.plist 与可执行文件。
 * 更新包下载中断/解压半途而废时这两者必缺其一——先校验再换包，绝不让残缺包上线。
 */
export function assertAppBundleComplete(bundleDir: string): void {
  const plist = path.join(bundleDir, 'Contents/Info.plist');
  const macos = path.join(bundleDir, 'Contents/MacOS');
  if (!fs.existsSync(plist)) throw new Error('更新包不完整：缺少 Contents/Info.plist（下载可能不完整）');
  if (!fs.existsSync(macos) || !fs.readdirSync(macos).length) throw new Error('更新包不完整：缺少 Contents/MacOS 可执行文件（下载可能不完整）');
}

export interface SwapOptions {
  zipPath: string;
  bundlePath: string;
  /** 解压暂存目录（测试注入）；默认建在系统临时目录，绝不落在 bundle 父目录里。 */
  workDir?: string;
  /** 解压完成、换位之前的钩子（仅测试用，观察暂存状态）。 */
  onStaged?: (stagingBundle: string) => void;
}

/**
 * 应用更新包：ditto 解压到独立暂存目录 → 校验 → 新旧换位。
 * 返回就位后的新 bundle 路径（与 bundlePath 同位同名）。
 */
export async function swapAppBundle(opts: SwapOptions): Promise<string> {
  const bundle = opts.bundlePath;
  const parent = path.dirname(bundle);
  fs.mkdirSync(parent, { recursive: true });
  // 暂存目录放系统临时目录：与旧包彻底隔离，解压失败只会脏在临时区。
  const work = opts.workDir ?? fs.mkdtempSync(path.join(os.tmpdir(), SWAP_STAGING_DIRNAME));
  const oldPath = bundle + OLD_BUNDLE_SUFFIX;
  const keepWork = Boolean(opts.workDir);
  try {
    try {
      await execFileAsync('/usr/bin/ditto', ['-x', '-k', opts.zipPath, work], { timeout: 15 * 60_000, maxBuffer: 4 * 1024 * 1024 });
    } catch (e) {
      const err = e as { stderr?: string; message?: string };
      const detail = (err.stderr || err.message || String(e)).trim().split('\n').slice(0, 3).join(' / ');
      // 关键：这条路径上旧包一个字节都没被碰过——失败是可重试的，不是数据事故。
      throw new Error(`解压更新包失败（旧版本未受影响）：${detail || '未知错误'}`);
    }
    const newApp = findAppBundle(work);
    if (!newApp) throw new Error('更新包里没有 .app bundle（下载可能不完整）');
    assertAppBundleComplete(newApp);
    opts.onStaged?.(newApp);
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
    if (!keepWork) fs.rmSync(work, { recursive: true, force: true });
  }
}

/** 启动清理：上次更新中断残留的旧 bundle 与换包暂存目录（正常流程已自删，这是兜底）。 */
export function cleanupOldBundle(bundlePath: string): void {
  try { fs.rmSync(bundlePath + OLD_BUNDLE_SUFFIX, { recursive: true, force: true }); } catch { /* best effort */ }
}

/** 启动清理：历史版本在 bundle 父目录里留下的 `.pi-update-work-*` 目录。 */
export function cleanupSwapResidue(bundlePath: string): void {
  const parent = path.dirname(bundlePath);
  let names: string[] = [];
  try { names = fs.readdirSync(parent); } catch { return; }
  for (const name of names) {
    if (!name.startsWith(SWAP_STAGING_DIRNAME)) continue;
    try { fs.rmSync(path.join(parent, name), { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
