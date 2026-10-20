#!/usr/bin/env node
/**
 * dist 安装包清理：只保留当前版本（package.json version）的安装包产物。
 *
 * electron-builder 每次 --dir/打包都会往 dist 根写 dmg/zip/exe/blockmap/latest-mac.yml，
 * 历史版本无人清理会堆积（实测 6 个版本 1.5G）。本脚本按当前 package.json 版本号
 * 保留匹配的安装包，删除其余版本产物。
 *
 * dist/{main,renderer,shared,preload} 是构建中间产物，不清（pnpm build 会重写）。
 * dist/mac-arm64 是本仓库自己 sync 用的中间目录，见下方 mac-arm64 小节。
 *
 * 用法：node scripts/prune-dist.mjs [--dry-run]
 */
import { readFileSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 支持 --root <dir> 覆盖仓库根（仅测试用：脚本要能对临时 dist 生效）。 */
const rootArgIndex = process.argv.indexOf('--root');
const root = rootArgIndex > 0 ? path.resolve(process.argv[rootArgIndex + 1]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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

  // electron-builder 每跑一次都会重新生成 dist/mac-arm64/（未签名的 .app + 中间符号），
  // 而它不在 ARTIFACT_PATTERN 的文件集合里，历史版本无人清理；更要命的是
  // sync-release.mjs 只在 `pnpm dist` 链路里删它——直接调 electron-builder 打发布包时
  // 不会删，dist 与 release 就各留一个同名 .app，被 LaunchServices/Spotlight 按路径
  // 各注册一份，启动台出现两个「PI Desktop」（2026-10-19 实测踩过）。
  // 兜底删整个 dist/mac-arm64：sync-release 已经把内容同步到 release/，这里再留一份
  // 只是给系统和用户制造困惑。
  const arm64 = path.join(dist, 'mac-arm64');
  if (existsSync(arm64)) {
    const size = dirSize(arm64);
    if (dryRun) {
      console.log(`[prune-dist] 将删除 dist/mac-arm64/（${format(size)}）`);
    } else {
      rmSync(arm64, { recursive: true, force: true });
      console.log(`[prune-dist] 已删除 dist/mac-arm64/（${format(size)}）`);
    }
    freed += size;
    removed++;
  }

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

/** 递归统计目录字节数；删除前调用，用于日志里的「释放了多少」。 */
function dirSize(dir) {
  let total = 0;
  const walk = (current) => {
    let entries;
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) { try { total += statSync(full).size; } catch { /* 竞态跳过 */ } }
    }
  };
  walk(dir);
  return total;
}

function format(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

main();
