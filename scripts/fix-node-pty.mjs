// node-pty 的 darwin 预编译产物 spawn-helper 在部分安装流程（pnpm store 解包）中
// 会丢失可执行位，导致 pty.spawn 报 posix_spawnp failed。安装后统一补权限。
import { chmodSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const root = path.dirname(new URL(import.meta.url, 'file://').pathname);
const candidates = [
  path.join(root, '..', 'node_modules', 'node-pty', 'prebuilds'),
  path.join(root, '..', 'node_modules', 'node-pty', 'build', 'Release'),
];

let fixed = 0;
for (const dir of candidates) {
  if (!existsSync(dir)) continue;
  const files = dir.endsWith('prebuilds')
    ? readdirSync(dir).flatMap(platform => readdirSync(path.join(dir, platform)).map(f => path.join(dir, platform, f)))
    : readdirSync(dir).map(f => path.join(dir, f));
  for (const file of files.filter(f => f.endsWith('spawn-helper'))) {
    try { chmodSync(file, 0o755); fixed += 1; } catch { /* 只读环境忽略 */ }
  }
}
if (fixed > 0) console.log(`fix-node-pty: +x on ${fixed} spawn-helper`);
