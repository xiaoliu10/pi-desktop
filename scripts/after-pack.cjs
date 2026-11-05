const fs = require('node:fs');
const path = require('node:path');

// 打包后补齐内置 pi runtime（electron-builder 26.15.3 回归，2026-11-05 发现）。
// 现象：extraResources 复制 resources/pi-runtime 时，产物里只剩 3 个 json——
// 完整 node_modules 被复制到了 appOutDir 根下的 Contents/（漏掉 <productName>.app
// 层级，且时机在 afterPack 之后，导致 afterPack 补齐被覆盖）。
// 后果：0.1.39-0.1.42 的 GitHub Release 产物全部缺失内置 runtime（zip 228MB→124MB），
// 下载用户装上后 bundled pi 无法启动；本机有 pi 的用户被本机优先逻辑掩盖。
// 修法：afterAllBuild（全部复制收尾后）把完整 runtime 覆盖到每个 unpacked 产物。
module.exports = async context => {
  const src = path.join(context.packager.projectDir, 'resources/pi-runtime');
  const isWin = context.electronPlatformName === 'win32';
  const checks = [
    path.join(src, 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'),
    path.join(src, 'node_modules/node/bin', isWin ? 'node.exe' : 'node'),
  ];
  for (const file of checks) {
    if (!fs.existsSync(file)) throw new Error('[after-all-build] 源 runtime 不完整（缺 ' + path.relative(src, file) + '），先运行 pnpm runtime:prepare');
  }
  // 所有 unpacked 产物目录（mac：dist/<productName>.app；win/linux：dist/<platform>-unpacked）
  const targets = [];
  const macApp = path.join(context.outDir, context.packager.appInfo.productFilename + '.app');
  const macRes = path.join(macApp, 'Contents', 'Resources', 'pi-runtime');
  if (fs.existsSync(path.join(macApp, 'Contents', 'Info.plist'))) targets.push(macRes);
  for (const dir of ['win-unpacked', 'linux-unpacked']) {
    const res = path.join(context.outDir, dir, 'resources', 'pi-runtime');
    if (fs.existsSync(path.join(context.outDir, dir))) targets.push(res);
  }
  // electron-builder 的错误位置产物（outDir/Contents/pi-runtime）若完整，直接挪用省一次复制
  const misplaced = path.join(context.outDir, 'Contents', 'pi-runtime');
  const misplacedComplete = checks.every(f => fs.existsSync(path.join(misplaced, path.relative(src, f))));
  let fixed = 0;
  for (const dest of targets) {
    // 26.15.3 已把一份完整 runtime 放到 outDir/Contents/：挪用；否则从源整目录复制
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (misplacedComplete) fs.cpSync(misplaced, dest, { recursive: true });
    else fs.cpSync(src, dest, { recursive: true });
    for (const file of checks) {
      if (!fs.existsSync(path.join(dest, path.relative(src, file)))) throw new Error('[after-all-build] runtime 补齐失败：' + path.relative(src, file));
    }
    fixed++;
  }
  // 错误位置的副本清掉（避免残留在产物目录里误导/占空间）
  if (fs.existsSync(misplaced)) fs.rmSync(misplaced, { recursive: true, force: true });
  const rootContents = path.join(context.outDir, 'Contents');
  if (fs.existsSync(rootContents) && fs.readdirSync(rootContents).length === 0) fs.rmSync(rootContents, { recursive: true, force: true });
  const pkg = JSON.parse(fs.readFileSync(path.join(targets[0], 'node_modules/@earendil-works/pi-coding-agent/package.json'), 'utf8'));
  console.log('[after-all-build] pi-runtime 补齐完成（pi ' + pkg.version + '，修复 ' + fixed + ' 个产物目录，' + context.electronPlatformName + '/' + context.arch + '）');
};
