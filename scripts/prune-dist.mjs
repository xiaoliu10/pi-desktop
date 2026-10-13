#!/usr/bin/env node
/**
 * dist 安装包清理：只保留当前版本（package.json version）的安装包产物。
 *
 * electron-builder 每次 --dir/打包都会往 dist 根写 dmg/zip/exe/blockmap/latest-mac.yml，
 * 历史版本无人清理会堆积（实测 6 个版本 1.5G）。本脚本按当前 package.json 版本号
 * 保留匹配的安装包，删除其余版本产物。
 *
 * dist/{main,renderer,shared,preload} 是构建中间产物，不清（pnpm build 会重写）。
 * dist/mac-arm64 由 scripts/sync-release.mjs 负责删除，本脚本也不碰。
 *
 * 用法：node scripts/prune-dist.mjs [--dry-run]
 */
import { readFileSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dryRun = process.argv.includes('--dry-run');

/** 安装包产物扩展名 / 固定文件名；目录（main/renderer/shared/preload/mac-arm64）不在其列。 */
const ARTIFACT_PATTERN = /\.(dmg|zip|exe|blockmap|yml)$/i;
/** electron-builder 的更新描述文件（latest-mac.yml / latest.yml / latest-linux.yml）：
 *  内容始终指向最近一次打包的版本，每次打包重写，不属于「历史版本垃圾」。 */
const LATEST_YML = /^latest.*\.yml$/i;

function currentVersion() {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const version = String(pkg.version ?? '').trim();
  if (!version) throw new Error('package.json 缺少 version 字段');
  return version;
}

function main() {
  const dist = path.join(root, 'dist');
  if (!existsSync(dist)) {
    console.log('[prune-dist] dist 不存在，无需清理');
    return;
  }
  const version = currentVersion();
  const entries = readdirSync(dist, { withFileTypes: true }).filter(e => e.isFile() && ARTIFACT_PATTERN.test(e.name));

  let removed = 0, freed = 0, kept = 0;
  for (const entry of entries) {
    const file = path.join(dist, entry.name);
    // 版本号后必须紧跟非数字或结尾：避免 "0.1.1" 把 "PI Desktop-0.1.18-*.dmg" 误判为当前版本
    // （includes 子串匹配的陷阱：短版本号是长版本号的前缀）。
    const versionRe = new RegExp(`${version.replace(/\./g, '\\.')}(?!\\d)`);
    const isCurrent = LATEST_YML.test(entry.name) || versionRe.test(entry.name);
    if (isCurrent) { kept++; continue; }
    const size = statSize(file);
    if (dryRun) {
      console.log(`[prune-dist] 将删除 ${entry.name}（${format(size)}）`);
    } else {
      rmSync(file, { force: true });
      console.log(`[prune-dist] 已删除 ${entry.name}（${format(size)}）`);
    }
    removed++;
    freed += size;
  }
  console.log(dryRun
    ? `[prune-dist] 试运行：保留 ${kept} 个当前版本（v${version}）产物，可释放 ${format(freed)}`
    : `[prune-dist] 完成：保留 ${kept} 个当前版本（v${version}）产物，释放 ${format(freed)}`);
}

function statSize(file) {
  try { return statSync(file).size; } catch { return 0; }
}

function format(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

main();
