#!/usr/bin/env node
/**
 * 打包后同步：dist/mac-arm64/PI Desktop.app → release/mac-arm64/PI Desktop.app
 * 用 ditto 保留签名/属性，删掉 dist 副本避免 Launchpad 出现两个应用。
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'dist', 'mac-arm64', 'PI Desktop.app');
const dest = path.join(root, 'release', 'mac-arm64', 'PI Desktop.app');

if (!fs.existsSync(src)) {
  console.error(`未找到打包产物: ${src}`);
  process.exit(1);
}

// 防护：目标 app 可能正在运行（用户日常就从 release/ 启动）。sync 是先 rmSync
// 整个 .app 再复制——运行中实例的按需读盘（connect 时校验 policy 扩展、spawn
// pi 子进程读 runtime）会在删除窗口内拿到 ENOENT，报「Desktop 工具权限扩展缺失」。
// 检测到运行中实例默认中止；--force 由构建者显式承担（已通知用户重启的场景）。
// 用 ps+grep 而非 pgrep：macOS pgrep 匹配不到调用者的祖先进程（本脚本常从
// PI Desktop 的 agent 会话里跑，主进程正是祖先，pgrep 会漏报）。
if (!process.argv.includes('--force')) {
  let running = '';
  try {
    running = execSync(`ps -eo command= | grep -F "${dest}/Contents/MacOS" | grep -v grep || true`, { encoding: 'utf8', shell: '/bin/bash' }).trim();
  } catch { /* 检测失败不阻塞构建——宁可放过不可误伤 */ }
  if (running) {
    console.error(
      `检测到目标 app 正在运行，同步会删除其磁盘文件，导致运行中实例 connect 报` +
      `「Desktop 工具权限扩展缺失」。运行中的相关进程：\n${running}\n` +
      `请先让用户 ⌘Q 退出 PI Desktop 再构建；若本次构建正由 PI Desktop 内的 agent 发起，` +
      `⌘Q 会连构建一起终止，请直接加 --force（用户随后 ⌘Q 重启加载新版）。`
    );
    process.exit(1);
  }
}

fs.mkdirSync(path.dirname(dest), { recursive: true });
if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true });
execSync(`ditto "${src}" "${dest}"`, { stdio: 'inherit' });
fs.rmSync(src, { recursive: true });
console.log(`已同步到 ${dest}（dist 副本已删除）`);
