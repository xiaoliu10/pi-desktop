#!/usr/bin/env node
// beforePack：把完整内置 pi runtime 预放到 Resources。
//
// 背景（2026-11-05 发布事故）：electron-builder 26.18 的 extraResources 复制
// resources/pi-runtime 时跳过 node_modules（<app>.app 里只剩 3 个 json；完整副本
// 被错误放到 outDir 根下 Contents/），0.1.39-0.1.42 的安装包（zip/dmg/exe）全部
// 缺内置 runtime。安装包在 electron-builder 内部生成，任何「打包后补齐」都来不及
// （sync-runtime 只能修 unpacked 目录），所以必须在复制阶段之前就把完整内容放到
// 目标位置：之后的 extraResources 残缺复制只会覆盖同名的 3 个 json 文件，
// 不会删除已存在的 node_modules 目录。
const fs = require('node:fs');
const path = require('node:path');

module.exports = async context => {
  const src = path.join(context.packager.projectDir, 'resources/pi-runtime');
  const isWin = context.electronPlatformName === 'win32';
  const checks = [
    path.join(src, 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'),
    path.join(src, 'node_modules/node/bin', isWin ? 'node.exe' : 'node'),
  ];
  for (const file of checks) {
    if (!fs.existsSync(file)) throw new Error('[before-pack] 源 runtime 不完整（缺 ' + path.relative(src, file) + '），先运行 pnpm runtime:prepare');
  }
  // 26.18 的 context.appOutDir 不含 .app 名（dist/mac-arm64），目标必须显式拼
  // <productName>.app/Contents/Resources；此时 electron 尚未解压，.app 目录由这里先建。
  // mac：<app>.app/Contents/Resources/pi-runtime；win/linux：<out>/resources/pi-runtime
  // （26.18 的 context.appOutDir 不含 .app 名；win/linux unpacked 目录 resources 为小写）
  const dest = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, context.packager.appInfo.productFilename + '.app', 'Contents', 'Resources', 'pi-runtime')
    : path.join(context.appOutDir, 'resources', 'pi-runtime');
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
  for (const file of checks) {
    if (!fs.existsSync(path.join(dest, path.relative(src, file)))) throw new Error('[before-pack] runtime 预放失败');
  }
  console.log('[before-pack] 内置 pi runtime 已预放（' + context.electronPlatformName + '/' + context.arch + '）');
};
