import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * GUI 启动的 Electron 只继承系统最小 PATH（macOS 实测 /usr/bin:/bin:/usr/sbin:/sbin），
 * 而 Homebrew/用户级 node 装在下面这些目录。pi-lens 等组件按 `#!/usr/bin/env node`
 * shebang 拉起语言服务器（typescript-language-server 等），PATH 缺目录 → env node 解析
 * 失败 → 每个 TS/JS 文件的 LSP 诊断全程 unavailable（2026-11-10 实测）。
 *
 * 这里只在主进程入口调用一次：补齐后写入 process.env.PATH，后续所有子进程
 * （pi RPC、utility worker、语言服务器、包管理 npm）统一继承，不依赖启动方式。
 *
 * 只追加**磁盘上真实存在**的目录，保持系统目录在前、补录目录在后；幂等，
 * 已包含的目录不重复追加。非 macOS 原样返回（Linux 打包/Windows 有自己的解析链）。
 */
export const DARWIN_PATH_CANDIDATES = [
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  path.join(os.homedir(), '.local/bin'),
  '/opt/local/bin',
];

type StatLike = (p: string) => fs.Stats;

/**
 * 返回补齐后的 PATH 字符串；不修改传入的 env（纯函数，便于测试）。
 * @param platform process.platform
 * @param env       要补齐的环境对象（读取 env.PATH）
 * @param stat      目录存在性探针（默认 fs.statSync，测试可注入）
 * @param candidates 候选绝对目录（默认 DARWIN_PATH_CANDIDATES，测试可重写到临时目录）
 */
export function augmentProcessPath(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  stat: StatLike = (p) => fs.statSync(p),
  candidates: readonly string[] = DARWIN_PATH_CANDIDATES,
): string {
  const current = String(env.PATH ?? '');
  const have = new Set(current.split(path.delimiter).filter(Boolean));
  if (platform !== 'darwin') return current;
  const additions: string[] = [];
  for (const dir of candidates) {
    if (have.has(dir) || additions.includes(dir)) continue;
    try {
      if (!stat(dir).isDirectory()) continue;
    } catch {
      continue; // 不存在或不可读：跳过，绝不因为单个候选失败影响其余
    }
    additions.push(dir);
  }
  if (!additions.length) return current;
  return current ? `${current}${path.delimiter}${additions.join(path.delimiter)}` : additions.join(path.delimiter);
}

/** 主进程入口调用：原地补齐 process.env.PATH，返回最终值。 */
export function ensureGuiPath(platform: NodeJS.Platform = process.platform): string {
  const next = augmentProcessPath(platform, process.env);
  process.env.PATH = next;
  return next;
}
