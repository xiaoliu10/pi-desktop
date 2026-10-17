import fs from 'node:fs';
import path from 'node:path';
import { installPackage, registerPackage } from './pi-packages';

/**
 * Desktop 内置默认包：首次启动（或用户卸载后重启）自动装进 pi 的 packages 注册。
 *
 * 为什么需要：这些包是 desktop 功能的依赖（子代理卡片/记忆/质量闸门），此前靠用户
 * 手动 `pi install`；新环境或重装后缺一个就废一块功能，且 pi 会话进程退出时会整包
 * 写回旧 settings 副本把注册抹掉（packages-repair 已兜底那种情况，但「从来没装过」
 * 不在它能力范围内）。
 *
 * 版本范围写在 spec 里（npm:name@^x.y.z）——升级要改这里发版，不靠 pi 的自动升级。
 */
export const BUILTIN_PACKAGES: ReadonlyArray<{ spec: string; /** 简短用途，冲突提示里给用户判断依据。 */ purpose: string }> = [
  { spec: 'npm:@wengine-ai/pi-subagents@^0.79.1', purpose: '子代理详情/运行中实时转录' },
  { spec: 'npm:@wengine-ai/pi-scoped-memory', purpose: '项目级记忆' },
  { spec: 'npm:@wengine-ai/pi-quality-prompt', purpose: '质量提示词' },
  { spec: 'npm:@wengine-ai/pi-quality-gates@^0.1.0', purpose: 'settle 返工闸 + edit 即时 lint' },
];

export interface BuiltinPackageReport {
  installed: string[];
  alreadyRegistered: string[];
  /** 装了但注册没补上（settings 写入失败等）——调用方应提示。 */
  failed: string[];
  /** 与用户已注册的同名（不同 scope/来源）包冲突，按用户优先、不动他的配置。 */
  conflicts: Array<{ builtin: string; purpose: string; existing: string }>;
}

function packageNameOf(spec: string): string {
  // npm:@scope/name@^1.2.3 → @scope/name；npm:name → name。
  const raw = spec.startsWith('npm:') ? spec.slice(4) : spec;
  const at = raw.lastIndexOf('@');
  return at > 0 ? raw.slice(0, at) : raw;
}

/** 功能域名：判定「用户已装的是不是同一能力的不同来源」。
 *  @wengine-ai/pi-subagents 与 pi-subagents 是不同 npm 名但同一功能（fork 关系）——
 *  这正是要提示用户的冲突：两个包都提供 subagent 工具，同时注册会双份工具/双份卡片。 */
function capabilityOf(spec: string): string {
  const name = packageNameOf(spec);
  const bare = name.startsWith('@') ? name.slice(name.indexOf('/') + 1) : name;
  return bare.replace(/^pi-/, '').replace(/-desktop$/, '');
}

function registeredSpecsOf(settings: Record<string, any>): string[] {
  const list = settings.packages;
  if (!Array.isArray(list)) return [];
  return list
    .map((raw: unknown) => typeof raw === 'string' ? raw : typeof raw === 'object' && raw ? String((raw as { source?: unknown }).source ?? '') : '')
    .filter(Boolean);
}

/**
 * 幂等：已在注册列表里的跳过；npm 依赖已在的只补注册（不重装，省一次 npm 往返）；
 * 都没有的才 `pi install`。冲突（同名但不同来源）按「用户优先」跳过并报告——
 * desktop 不擅自替换用户自己装的包（例如上游 pi-subagents）。
 */
export async function ensureBuiltinPackages(
  piExecutable: string | undefined,
  agentDir: string,
  dataDir: string,
  opts: { log?: (line: string) => void; installTimeoutMs?: number } = {},
): Promise<BuiltinPackageReport> {
  const report: BuiltinPackageReport = { installed: [], alreadyRegistered: [], failed: [], conflicts: [] };
  const settingsPath = path.join(agentDir, 'settings.json');
  let settings: Record<string, any> = {};
  try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); if (!settings || typeof settings !== 'object' || Array.isArray(settings)) settings = {}; } catch { settings = {}; }
  const registered = registeredSpecsOf(settings);
  // 去重用完整 npm 名；冲突判定用功能域名（见 capabilityOf 注释）。
  const registeredNames = new Set(registered.map(packageNameOf));
  const registeredCaps = new Map(registered.map(spec => [capabilityOf(spec), spec]));

  for (const builtin of BUILTIN_PACKAGES) {
    const name = packageNameOf(builtin.spec);
    if (registered.includes(builtin.spec)) { report.alreadyRegistered.push(builtin.spec); continue; }
    // 同一功能的不同来源：用户已装（上游 pi-subagents 或自选变体）——不碰，报告。
    const cap = capabilityOf(builtin.spec);
    const existing = registeredCaps.get(cap);
    if (existing && !registeredNames.has(name)) {
      report.conflicts.push({ builtin: builtin.spec, purpose: builtin.purpose, existing });
      continue;
    }
    // npm 依赖已在（用户手动 pi install 过但注册被抹）→ 只补注册，不重装。
    const npmDeps = readNpmDeps(agentDir);
    const alreadyInstalled = npmDeps.has(name);
    if (piExecutable && !alreadyInstalled) {
      try {
        opts.log?.(`[builtin-packages] installing ${builtin.spec}`);
        await installPackage(piExecutable, builtin.spec, dataDir, 'install');
        report.installed.push(builtin.spec);
      } catch (error) {
        report.failed.push(builtin.spec);
        opts.log?.(`[builtin-packages] install failed ${builtin.spec}: ${String((error as Error).message || error)}`);
        continue;
      }
    } else {
      report.installed.push(builtin.spec);
    }
    try {
      await registerPackage(agentDir, builtin.spec);
      recordDesired(dataDir, builtin.spec);
      registered.push(builtin.spec);
      registeredNames.add(name);
    } catch (error) {
      report.failed.push(builtin.spec);
      opts.log?.(`[builtin-packages] register failed ${builtin.spec}: ${String((error as Error).message || error)}`);
    }
  }
  return report;
}

function readNpmDeps(agentDir: string): Set<string> {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(agentDir, 'npm', 'package.json'), 'utf8'));
    return new Set(Object.keys(pkg.dependencies ?? {}));
  } catch { return new Set(); }
}

/** 记录期望注册列表：pi 会话进程退出/切模型时会整包写回旧设置副本覆盖 packages，
 *  packages-repair 据此自愈补回。与 host.packageRegister 同格式（pi-desktop.json）。 */
function recordDesired(dataDir: string, spec: string): void {
  try {
    const file = path.join(dataDir, 'pi-desktop.json');
    const prefs = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    const list = Array.isArray(prefs.piPackages) ? prefs.piPackages : [];
    if (!list.includes(spec)) { prefs.piPackages = [...list, spec]; fs.writeFileSync(file, `${JSON.stringify(prefs, null, 2)}\n`); }
  } catch { /* 记录失败不影响本次注册 */ }
}

/** 首次运行标记：同一份 dataDir 只在第一次跑 ensureBuiltinPackages 时真正联网安装。 */
export function builtinPackagesSeeded(dataDir: string): boolean {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'pi-desktop.json'), 'utf8')).builtinPackagesSeeded === true; } catch { return false; }
}

export function markBuiltinPackagesSeeded(dataDir: string): void {
  try {
    const file = path.join(dataDir, 'pi-desktop.json');
    const prefs = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    if (prefs.builtinPackagesSeeded === true) return;
    prefs.builtinPackagesSeeded = true;
    fs.writeFileSync(file, `${JSON.stringify(prefs, null, 2)}\n`);
  } catch { /* best-effort */ }
}
