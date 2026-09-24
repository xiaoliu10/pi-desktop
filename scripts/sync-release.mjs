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

fs.mkdirSync(path.dirname(dest), { recursive: true });
if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true });
execSync(`ditto "${src}" "${dest}"`, { stdio: 'inherit' });
fs.rmSync(src, { recursive: true });
console.log(`已同步到 ${dest}（dist 副本已删除）`);
