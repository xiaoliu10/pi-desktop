#!/usr/bin/env node
// 打包后补齐内置 pi runtime（electron-builder 26.18.0 回归，2026-11-05 发现）。
//
// 现象：extraResources 复制 resources/pi-runtime 到产物时，<app>.app 里只剩
// 3 个 json；完整 node_modules 被复制到了 outDir 根下的 Contents/（漏掉
// <productName>.app 层级）。0.1.39-0.1.42 的 GitHub Release 产物全部缺失
// 内置 runtime（mac zip 228MB→124MB），下载用户装上后 bundled pi 无法启动；
// 本机装有 pi CLI 的用户被 environment.ts 的本机优先逻辑掩盖，一直未暴露。
//
// 必须在 electron-builder 收尾后运行（26.18.0 的 extraResources 复制发生在
// afterPack 之后，hook 补齐会被覆盖）。CI 的 release.yml 在 electron-builder
// 之后调用本脚本；本地 dist 链路同理。
//
// 用法：node scripts/sync-runtime.cjs [outDir ...]（缺省扫 dist/*）
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const src = path.join(root, 'resources/pi-runtime');
const checks = [
  'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js',
  process.platform === 'win32' ? 'node_modules/node/bin/node.exe' : 'node_modules/node/bin/node',
];
for (const rel of checks) {
  if (!fs.existsSync(path.join(src, rel))) {
    console.error(`[sync-runtime] 源 runtime 不完整（缺 ${rel}），先运行 pnpm runtime:prepare`);
    process.exit(1);
  }
}

// 收集需要补齐的 outDir：命令行参数优先，否则扫 dist/*
let outDirs = process.argv.slice(2);
if (outDirs.length === 0) {
  const dist = path.join(root, 'dist');
  outDirs = fs.existsSync(dist)
    ? fs.readdirSync(dist).filter(name => {
        const p = path.join(dist, name);
        return fs.statSync(p).isDirectory() && !name.startsWith('builder-');
      }).map(name => path.join(dist, name))
    : [];
}

let fixed = 0;
for (const outDir of outDirs) {
  if (!fs.existsSync(outDir)) continue;
  // 各种产物布局：mac 的 <app>.app/Contents/Resources；win/linux 的 <dir>/resources
  const candidates = [];
  // mac 布局：<outDir>/<app>.app/Contents/Resources/pi-runtime
  // win/linux 布局：<outDir>/<platform>-unpacked/resources/pi-runtime
  const walk = (dir, depth) => {
    if (depth > 3) return;
    for (const name of ['Resources', 'resources']) {
      const res = path.join(dir, name);
      if (fs.existsSync(path.join(res, 'pi-runtime'))) candidates.push(path.join(res, 'pi-runtime'));
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && (entry.name.endsWith('.app') || entry.name.endsWith('-unpacked') || (entry.name === 'Contents' && depth >= 1))) {
        walk(path.join(dir, entry.name), depth + 1);
      }
    }
  };
  walk(outDir, 0);

  for (const dest of candidates) {
    // 残缺判定：有 package.json 但缺 cli.js（完整 runtime 必含）
    const cliOk = fs.existsSync(path.join(dest, checks[0]));
    if (cliOk) continue;
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(src, dest, { recursive: true });
    if (!fs.existsSync(path.join(dest, checks[0]))) {
      console.error(`[sync-runtime] 补齐失败：${dest}`);
      process.exit(1);
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(dest, 'node_modules/@earendil-works/pi-coding-agent/package.json'), 'utf8'));
    console.log(`[sync-runtime] 已补齐 ${path.relative(root, dest)}（pi ${pkg.version}）`);
    fixed++;
  }

  // 清理 26.18.0 复制到 outDir 根 Contents/ 的错误位置副本
  const misplaced = path.join(outDir, 'Contents', 'pi-runtime');
  if (fs.existsSync(misplaced)) {
    fs.rmSync(misplaced, { recursive: true, force: true });
    const contentsDir = path.join(outDir, 'Contents');
    if (fs.existsSync(contentsDir) && fs.readdirSync(contentsDir).length === 0) fs.rmSync(contentsDir, { recursive: true, force: true });
    console.log('[sync-runtime] 已清理错误位置副本：' + path.relative(root, misplaced));
  }
}
console.log(`[sync-runtime] 完成：补齐 ${fixed} 个产物目录`);
if (fixed === 0) console.log('[sync-runtime] 提示：没有发现需要补齐的产物（要么本就不缺，要么未找到产物目录）');
