#!/usr/bin/env node
// 保留原有源 runtime 架构校验，再预放完整 runtime 到 electron-builder 的
// 实际打包目录。afterPack 再次检查最终打包输入，不依赖安装包体积判定。
const fs = require('node:fs');
const path = require('node:path');
const checkRuntime = require('./check-runtime.cjs');

function resourcesPath(context) {
  return context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, context.packager.appInfo.productFilename + '.app', 'Contents', 'Resources', 'pi-runtime')
    : path.join(context.appOutDir, 'resources', 'pi-runtime');
}

module.exports = async context => {
  await checkRuntime(context);
  const src = path.join(context.packager.projectDir, 'resources/pi-runtime');
  const dest = resourcesPath(context);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
  const relCli = 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js';
  if (!fs.existsSync(path.join(dest, relCli))) throw new Error('[before-pack] runtime 预放失败');
  console.log('[before-pack] 源 runtime 架构校验及完整预放通过');
};
