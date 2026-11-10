import fs from 'node:fs';
import path from 'node:path';
import { packageNameOf } from './package-spec';
import { looksDesktopNamed } from './third-party-ask';

/**
 * 谁会提供 desktop_update_plan（v0.1.47 回归修复，用户实测「启动报错」）：
 *
 * desktop-policy 是 Desktop 注入的第一个 -e 扩展，它在加载时靠「运行时探测同名
 * 工具是否已注册」让位给 npm 包——但此刻包还没被 pi 装载，探测必然落空：内置副本
 * 先注册，随后 pi 装载 @wengine-ai/pi-plan-tool 时同名冲突，pi 在扩展加载阶段直接
 * 抛错退出，每个会话都起不来（渲染层只剩 null 引用报错）。#193 把 pi-plan-tool
 * 列入 BUILTIN_PACKAGES（必定注册）后，冲突从偶发变成必然。
 *
 * 修法：让位判定提到 launch 层（与 detectThirdPartyAsk 同模式）。这里探测「npm 包
 * 是否会提供该工具」，backend 据此置 PI_DESKTOP_PLAN_PACKAGE=1，plan.mjs 见标记跳过
 * 内置注册。保留的必须是 npm 包——TUI 与 GUI 共用同一份实现（用户 2026-11-09 裁定）。
 *
 * 已知局限（与 detectThirdPartyAsk 同边界）：纯名字启发式，注册同名工具但包名不含
 * 特征的插件防不住。判定刻意偏保守：要求包真的可解析（声明了但没装上 → 不让位，
 * 内置副本兜底）——工具整个消失比多注册一份内置副本更难排查。
 */

/** 计划工具包的识别特征：本尊 @wengine-ai/pi-plan-tool + 常见变体（plan-tool/plan_tool）。 */
const PLAN_PACKAGE_PATTERN = /pi-plan-tool|plan[-_.]?tool/i;

export function detectPlanPackage(agentDir: string): { detected: boolean; source?: string } {
  // 1) settings.json packages[]（pi 两种形态都写：字符串或 {source}）。声明了还必须
  //    真装进 agentDir/npm/node_modules 才算——「声明未安装」时让位会让
  //    desktop_update_plan 整个消失（--tools 里列了不存在的工具、侧栏进程空掉）。
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8'));
    const pkgs: unknown[] = Array.isArray(settings?.packages) ? settings.packages : [];
    for (const p of pkgs) {
      const s = typeof p === 'string' ? p : typeof p === 'object' && p ? String((p as { source?: unknown }).source ?? '') : '';
      if (!s || !PLAN_PACKAGE_PATTERN.test(s) || looksDesktopNamed(s)) continue;
      const name = packageNameOf(s.startsWith('npm:') ? s : `npm:${s}`);
      if (fs.existsSync(path.join(agentDir, 'npm', 'node_modules', name))) return { detected: true, source: s };
    }
  } catch { /* settings may not exist yet */ }
  // 2) agentDir/extensions/ 手装目录（git clone 形态）。
  try {
    const extDir = path.join(agentDir, 'extensions');
    if (fs.existsSync(extDir)) {
      for (const name of fs.readdirSync(extDir)) {
        if (!PLAN_PACKAGE_PATTERN.test(name) || looksDesktopNamed(name)) continue;
        try {
          if (fs.statSync(path.join(extDir, name)).isDirectory()) return { detected: true, source: name };
        } catch { /* A stale symlink must not hide other installed extensions. */ }
      }
    }
  } catch { /* unreadable extensions dir */ }
  // 3) autoload 形态：npm/node_modules/ 下带 pi.extensions 清单的包（settings.json
  //    无 packages 键也会被 pi 捞进来）。兼容 npm 的 @scope/name 两级目录。
  try {
    const nmDir = path.join(agentDir, 'npm', 'node_modules');
    if (!fs.existsSync(nmDir)) return { detected: false };
    for (const entry of fs.readdirSync(nmDir)) {
      const dirs: Array<{ name: string; dir: string }> = [];
      if (entry.startsWith('@')) {
        let subs: string[] = [];
        try { subs = fs.readdirSync(path.join(nmDir, entry)); } catch { continue; }
        for (const sub of subs) dirs.push({ name: `${entry}/${sub}`, dir: path.join(nmDir, entry, sub) });
      } else {
        dirs.push({ name: entry, dir: path.join(nmDir, entry) });
      }
      for (const { name, dir } of dirs) {
        if (!PLAN_PACKAGE_PATTERN.test(name) || looksDesktopNamed(name)) continue;
        let pkg: { pi?: { extensions?: unknown } };
        try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { continue; }
        if (Array.isArray(pkg?.pi?.extensions) && pkg.pi.extensions.length > 0) return { detected: true, source: name };
      }
    }
  } catch { /* best-effort detection */ }
  return { detected: false };
}
