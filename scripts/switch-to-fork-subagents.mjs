#!/usr/bin/env node
/**
 * 一次性迁移：pi-subagents → @wengine-ai/pi-subagents（PI Desktop fork）。
 *
 * 背景：上游 pi-subagents 不在运行中暴露 child 的 sessionFile/currentTool（issue
 * #2921 gap 1），desktop 侧拿不到实时转录。fork 已发 npm：@wengine-ai/pi-subagents@0.79.1
 * （在 0.79.0 基础上加了「运行中发布 sessionFile + children activity」）。
 *
 * 改三处（全部是用户环境的注册/依赖状态，不改任何代码）：
 *   1. ~/.pi/agent/settings.json        的 packages[]：npm:pi-subagents → npm:@wengine-ai/pi-subagents@^0.79.1
 *   2. <dataDir>/pi-desktop.json        的 piPackages[]：同上（packages-repair 的期望列表，
 *      不同步的话自愈会把旧 spec 又写回 settings.json）
 *   3. ~/.pi/agent/npm/package.json     的 dependencies：pi-subagents → @wengine-ai/pi-subagents@^0.79.1
 *
 * 幂等：已是新 spec 就跳过；旧 spec 不存在就报错退出（不静默）。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const NEW_SPEC = 'npm:@wengine-ai/pi-subagents@^0.79.1';
const OLD_SPEC = 'npm:pi-subagents';
const OLD_DEP = 'pi-subagents';
const NEW_DEP = '@wengine-ai/pi-subagents';
const RANGE = '^0.79.1';

const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), '.pi', 'agent');
const dataDir = process.env.PI_DESKTOP_DATA_DIR ?? path.join(os.homedir(), 'Library', 'Application Support', 'PI Desktop');
const settingsPath = path.join(agentDir, 'settings.json');
const desiredPath = path.join(dataDir, 'pi-desktop.json');
const npmPkgPath = path.join(agentDir, 'npm', 'package.json');

const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

const replaceInList = (list, label) => {
  if (!Array.isArray(list)) throw new Error(`${label} 不是数组`);
  if (list.includes(NEW_SPEC)) return { list, changed: false };
  const at = list.indexOf(OLD_SPEC);
  if (at < 0) throw new Error(`${label} 里找不到 ${OLD_SPEC}`);
  const next = [...list];
  next[at] = NEW_SPEC;
  return { list: next, changed: true };
};

let touched = 0;

// 1. settings.json packages[]
if (fs.existsSync(settingsPath)) {
  const settings = read(settingsPath);
  const { list, changed } = replaceInList(settings.packages ?? [], 'settings.json packages');
  if (changed) { settings.packages = list; write(settingsPath, settings); console.log(`✓ settings.json: ${OLD_SPEC} → ${NEW_SPEC}`); touched += 1; }
  else console.log('· settings.json 已是新 spec');
} else console.log('! settings.json 不存在，跳过');

// 2. pi-desktop.json piPackages[]（packages-repair 期望列表）
if (fs.existsSync(desiredPath)) {
  const prefs = read(desiredPath);
  const { list, changed } = replaceInList(prefs.piPackages ?? [], 'pi-desktop.json piPackages');
  if (changed) { prefs.piPackages = list; write(desiredPath, prefs); console.log(`✓ pi-desktop.json: ${OLD_SPEC} → ${NEW_SPEC}`); touched += 1; }
  else console.log('· pi-desktop.json 已是新 spec');
} else console.log('! pi-desktop.json 不存在，跳过（首次安装时会以新 spec 记录）');

// 3. npm/package.json dependencies
if (fs.existsSync(npmPkgPath)) {
  const pkg = read(npmPkgPath);
  const deps = pkg.dependencies ?? {};
  if (deps[NEW_DEP]) console.log('· npm/package.json 已是新依赖');
  else if (!(OLD_DEP in deps)) console.log(`! npm/package.json 没有 ${OLD_DEP} 依赖，跳过`);
  else {
    const next = {};
    for (const [name, range] of Object.entries(deps)) {
      if (name === OLD_DEP) next[NEW_DEP] = RANGE;
      else next[name] = range;
    }
    pkg.dependencies = next;
    write(npmPkgPath, pkg);
    console.log(`✓ npm/package.json: ${OLD_DEP} → ${NEW_DEP}@${RANGE}`);
    touched += 1;
  }
} else console.log('! npm/package.json 不存在，跳过');

console.log(`\n完成：${touched} 处改动。`);
console.log('下一步：在 ~/.pi/agent/npm 下跑 `pnpm install`（或 npm install）拉新包，然后重启 app。');
if (!touched) console.log('（无需改动——环境已是 fork 包）');
