#!/usr/bin/env node
// afterPack：校验安装包输入目录里的内置 pi runtime 完整（缺则补齐）。
//
// 与 before-pack.cjs 配对（2026-11-05 发布事故）：electron-builder 26.18 的
// extraResources 残缺复制（跳过 node_modules，只放 3 个 json）发生在 afterPack
// 之后或之前取决于版本与时序，这里在 afterPack 时刻做最终校验：cli.js 缺失就
// 整目录补齐。安装包（zip/dmg/exe）在本阶段之后的 artifact 生成步骤里从该目录
// 取内容，因此必须保证此刻完整。
const fs = require('node:fs');
const path = require('node:path');

module.exports = async context => {
  const src = path.join(context.packager.projectDir, 'resources/pi-runtime');
  const isWin = context.electronPlatformName === 'win32';
  const relCli = 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js';
  // mac：<app>.app/Contents/Resources/pi-runtime；win/linux：<out>/resources/pi-runtime
  // （26.18 的 context.appOutDir 不含 .app 名；win/linux unpacked 目录 resources 为小写）
  const dest = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, context.packager.appInfo.productFilename + '.app', 'Contents', 'Resources', 'pi-runtime')
    : path.join(context.appOutDir, 'resources', 'pi-runtime');
  if (!fs.existsSync(dest)) {
    throw new Error('[after-pack] runtime 打包目标不存在：' + dest);
  }
  if (fs.existsSync(path.join(dest, relCli))) {
    console.log('[after-pack] 内置 pi runtime 完整，无需补齐');
    return;
  }
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
  if (!fs.existsSync(path.join(dest, relCli))) throw new Error('[after-pack] runtime 补齐失败');
  console.log('[after-pack] 内置 pi runtime 残缺，已补齐');
};
