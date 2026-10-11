/**
 * package.json 完整性哨兵：本仓库工作区 package.json 曾三次被静默截断
 * （scripts/devDependencies 全丢、文件停在合法 JSON 边界、无 .tmp 残留，
 * 表现为 `pnpm typecheck` 突然 Command not found）。截断源未能定位
 * （发版打包期间的某个写动作被中断），故用本脚本在 typecheck/test 前 fail fast：
 * 校验 package.json 仍是含 scripts 与 devDependencies 的完整清单。
 *
 * 用法：node scripts/check-package-json.mjs（exit 1 = 已损坏，按提示恢复）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'package.json');
const REQUIRED_SCRIPTS = ['build', 'typecheck', 'test', 'dist', 'runtime:prepare'];
const fail = (message) => {
  console.error(`[check-package-json] ${message}`);
  console.error('[check-package-json] 恢复命令：git checkout -- package.json（然后重设 version）');
  process.exit(1);
};

let doc;
try {
  doc = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (error) {
  fail(`package.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
}
const problems = [];
if (!doc.scripts || typeof doc.scripts !== 'object' || Object.keys(doc.scripts).length < 5) problems.push('scripts 段缺失或异常短');
else for (const name of REQUIRED_SCRIPTS) if (typeof doc.scripts[name] !== 'string') problems.push(`scripts.${name} 缺失`);
if (!doc.devDependencies || typeof doc.devDependencies !== 'object' || Object.keys(doc.devDependencies).length < 5) problems.push('devDependencies 段缺失或异常短');
if (typeof doc.version !== 'string' || !/^\d+\.\d+\.\d+/.test(doc.version)) problems.push('version 缺失或非法');
if (problems.length) fail(`package.json 不完整：${problems.join('；')}`);
console.log(`[check-package-json] OK（version ${doc.version}，scripts ${Object.keys(doc.scripts).length}，devDependencies ${Object.keys(doc.devDependencies).length}）`);
