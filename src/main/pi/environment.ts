import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PiEnvironment, PiPreferences } from '../../shared/pi';

export function expand(value: string): string { return path.resolve(value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value); }

/** Lowest pi version whose RPC protocol desktop understands. */
const PI_MIN_VERSION = '0.85.1';
/** Exclusive upper bound for external CLI compatibility. Versions at or above this
 *  are rejected and fall back to bundled when available. Review per release.
 *  0.99.x/1.0.0 已核对 RPC 命令/事件面全兼容（docs/pi-0.99-adaptation.md，1.0.0 bundle 拆 chunks 无碍）；
 *  1.2.0 已核对：RPC 命令集 33 个与 1.1.0 逐一相同、事件面（extension_error/extension_ui_request/
 *  response/user_bash）无增减、Desktop 依赖的 13 个命令签名不变（prompt/set_model/
 *  get_available_thinking_levels 等）；实测捆绑 1.2.0 六命令 RPC 冒烟全通。
 *  1.3.0 已核对（2026-10-16）：rpc-types.d.ts 与 1.2.0 **零差异**（请求/响应/事件契约不变）、
 *  rpc-mode.js 与 1.2.0 逐字节相同（33 命令面不变）、model-registry.js / extensions/runner.js /
 *  extensions/types.d.ts / sdk.js 全部相同；bundle 重新拆 chunks（chunk 哈希变化）但
 *  rpc-entry.js 入口语义不变。唯一实质差异是 agent-session.js 的
 *  `_restoreToolsFromTranscript(modifiers)`（上游修 continue 后工具丢失，见 pi-subagents #2916）：
 *  Desktop 传显式 `--tools` 白名单且不含 `+/-` 修饰符 → `toolModifiers === undefined` →
 *  `usesDefaultTools === false`，该分支不生效，白名单行为不变。
 *  上界是**排他**的（compareVersion < 0），故设为 1.5.0 表示「已测到 1.4.x」。
 *  1.4.0 已核对（2026-10-27）：modes/rpc/rpc-mode.js 与 1.3.0 **逐字节相同**、rpc-types.d.ts
 *  **零差异**（33 命令面/事件契约不变）、model-registry.js / extensions/runner.js / extensions/types.d.ts
 *  相同；所检查文件中的差异包括 sdk.js（provider attribution 改走 pi-ai client identity）、
 *  model-runtime.js（OpenCode 会话头合并）与 bundle chunk 哈希。before_provider_headers 不再看到
 *  部分 attribution 头（详见上游 CHANGELOG）。上游还修复 #11062/#11075（resume 后新增扩展工具
 *  的激活），是否覆盖 desktop_handoff 的现场问题仍需独立验证。
 *  pnpm smoke:rpc 与 pnpm smoke:rpc-full 在内置 1.4.0 runtime 上全绿。
 *  **升级到新 pi 版本时必须同步**：跑 `pnpm smoke:rpc` + `pnpm smoke:rpc-full`（见
 *  docs/requirements.md R-model-01），两者都过再把这里 +1。 */
export const PI_MAX_TESTED = '1.6.0';

/** pi ≥0.99 内置原生 MCP（builtin:mcp，读同一份 mcp.json）：desktop 的 mcp-bridge 必须
 *  让位，否则同一服务器双连接、工具双注册。backend 以 PI_DESKTOP_PI_VERSION 注入运行时版本。 */
export function piHasNativeMcp(version: string | null | undefined): boolean {
  if (!version) return false;
  return compareVersion(version, '0.99.0') >= 0;
}

/** 0 if equal, -1 if a<b, 1 if a>b. Blank/invalid sorts below everything. */
export function compareVersion(a?: string | null, b?: string | null): number {
  const pa = String(a ?? '').split('.').map((n) => Number.parseInt(n, 10));
  const pb = String(b ?? '').split('.').map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = Number.isFinite(pa[i]) ? pa[i] : -1;
    const y = Number.isFinite(pb[i]) ? pb[i] : -1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** A local CLI version desktop will actually launch via RPC.
 *  Windows 本机 npm 安装的 pi 自 #168 起支持：入口是 `.cmd` shim，Node 不能直接 spawn
 *  （CVE-2024-27980 → EINVAL），但解析出 node + cli.js 后直启是可行的（真机实测）。
 *  此前这里一律 `return false`，本地 CLI 永远不被选中，用户只能永远用内置 pi。 */
export function piVersionSupported(version: string | null): boolean {
  if (!version) return false;
  return compareVersion(version, PI_MIN_VERSION) >= 0 && compareVersion(version, PI_MAX_TESTED) < 0;
}

/** 解析后的 Windows shim 启动目标。 */
export interface WindowsShimTarget {
  /** 实际要 spawn 的可执行文件（node.exe，或 PATH 上的 `node`）。 */
  node: string | null;
  /** pi 的真实 JS 入口（cli.js）。 */
  js: string;
}

export interface WindowsLaunchTarget {
  command: string;
  args: string[];
  /** 恒为 false：桌面始终不走 shell（CVE-2024-27980 + Program Files 空格转义双重原因）。 */
  shell: false;
}

/** 在 PATH 里找真实的 node 解释器（Windows 下偏好 node.exe）。找不到返回 null。
 *  绝不回退到 process.execPath：那在 Windows 上可能是 Desktop 自己的 Electron，
 *  而 RPC 启动会删掉 ELECTRON_RUN_AS_NODE，结果就是启动了 Electron 而不是 pi。 */
export function findNodeOnPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  const exts = platform === 'win32' ? ['node.exe'] : ['node'];
  for (const dir of String(env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, ext);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        fs.accessSync(candidate, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
        return candidate;
      } catch { /* try next */ }
    }
  }
  return null;
}

/**
 * 从 npm 在 Windows 生成的 `.cmd` shim 里解析出 node 与 JS 入口。
 *
 * npm 的 cmd-shim 有两个形态（真机两种都实测过）：
 *  - 现代（longProg）：`IF EXIST "%dp0%\node.exe"` + `"%_prog%" "%dp0%\<pkg>\cli.js" %*`
 *  - 老版：直接 `node "%dp0%\<pkg>\cli.js" %*`
 * 解析不到 `.js` 时返回 null —— 宁可回退内置 pi，也不猜一个可执行路径去 spawn。
 */
export function parseWindowsShim(shimFile: string): WindowsShimTarget | null {
  let raw: string;
  try { raw = fs.readFileSync(shimFile, 'utf8'); } catch { return null; }
  const dir = path.dirname(shimFile);
  // 只认 `%dp0%\.js` 形式：shim 里的相对路径都是相对自身目录。
  const m = /"%dp0%\\?([^"]+?\.js)"/i.exec(raw) ?? /%dp0%\\?([^"\s]+?\.js)/i.exec(raw);
  if (!m) return null;
  const js = path.join(dir, m[1].replace(/\\/g, path.sep));
  if (!fs.existsSync(js)) return null;
  // 现代 shim 会优先用与自身同目录的 node.exe；没有再交给 PATH 上的 node。
  const pinned = path.join(dir, 'node.exe');
  const node = /IF EXIST\s+"%dp0%\\node\.exe"/i.test(raw) && fs.existsSync(pinned) ? pinned : null;
  return { node, js };
}

/**
 * 把 `.cmd` shim 转成可直接 spawn 的目标：`node <cli.js>`，且明确 shell:false。
 * 解析失败返回 null，调用方应回退内置运行时。
 *
 * `fallbackNode` 应当是**在 PATH 上真实找到的 node**（见 findNodeOnPath），不得传
 * process.execPath —— Windows 上那是 Desktop 的 Electron，RPC 启动删除
 * ELECTRON_RUN_AS_NODE 后会启动 Electron 而非 pi。
 */
export function windowsLaunchTarget(
  shimFile: string,
  fallbackNode: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): WindowsLaunchTarget | null {
  const parsed = parseWindowsShim(shimFile);
  if (!parsed) return null;
  const command = parsed.node ?? fallbackNode ?? findNodeOnPath(env);
  if (!command) return null;
  return { command, args: [parsed.js], shell: false };
}

function discoverExternalPi(prefs: PiPreferences = {}, env = process.env): PiEnvironment {
  const agentDir = expand(prefs.agentDir || env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi/agent'));
  const sessionDirs = [...new Set([expand(env.PI_CODING_AGENT_SESSION_DIR || path.join(agentDir, 'sessions')), ...(prefs.sessionDirs || []).map(expand)])];
  const names = process.platform === 'win32' ? ['pi.cmd', 'pi.exe', 'pi'] : ['pi'];
  const candidates = prefs.executable ? [expand(prefs.executable)] : [
    ...(env.PATH || '').split(path.delimiter).filter(Boolean).flatMap(dir => names.map(name => path.join(dir, name))),
    '/opt/homebrew/bin/pi', '/usr/local/bin/pi', path.join(os.homedir(), '.local/bin/pi'),
  ];
  const diagnostics: string[] = [];
  let executable: string | null = null, version: string | null = null;
  // Windows：找到 .cmd shim 时必须换成 `node <cli.js>` 直接启动。
  // Node 不能 spawn .cmd（CVE-2024-27980 → EINVAL），而 shim 目录本身也没有 package.json，
  // 所以版本要从解析出的 cli.js 往上找。#168 真机实测（2026-11-02）。
  let launchArgs: string[] | undefined;
  const win = process.platform === 'win32';
  for (const candidate of candidates) {
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
      let entry = candidate;
      let args: string[] | undefined;
      if (win && /\.(cmd|bat)$/i.test(candidate)) {
        // 不传 process.execPath：Windows 上那是 Desktop 的 Electron，RPC 启动会删
        // ELECTRON_RUN_AS_NODE，结果启动的是 Electron 而不是 pi。让它在 PATH 上找真 node。
        const target = windowsLaunchTarget(candidate, undefined, env);
        if (!target) { diagnostics.push(`本地 pi 入口 ${candidate} 无法解析出 JS 入口，已跳过；可重装本地 CLI。`); continue; }
        entry = target.command;
        args = target.args;
      }
      executable = entry;
      launchArgs = args;
      let dir = path.dirname(fs.realpathSync(args?.[0] ?? candidate));
      for (;;) {
        const manifest = path.join(dir, 'package.json');
        if (fs.existsSync(manifest)) {
          const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
          if (['@earendil-works/pi-coding-agent', '@mariozechner/pi-coding-agent'].includes(pkg.name)) { version = pkg.version; break; }
        }
        const parent = path.dirname(dir); if (parent === dir) break; dir = parent;
      }
      break;
    } catch { /* Try the next installation, without executing it. */ }
  }
  const supported = piVersionSupported(version);
  if (!executable) diagnostics.push('未找到本地 pi，已使用内置运行时；如需本机 CLI 可安装后选择「自动」或「本机 pi」。');
  else if (!supported) diagnostics.push(`本地 pi 版本 ${version || '未知'} 不在兼容区间 [${PI_MIN_VERSION}, ${PI_MAX_TESTED})，已回退内置 pi；可升级本地 CLI 后切换。`);
  if (!fs.existsSync(agentDir)) diagnostics.push('pi 配置目录尚不存在。');
  return { executable, version, supported, agentDir, sessionDirs, diagnostics, runtime: undefined, requestedRuntime: undefined, launchArgs, customExecutable: undefined, fallback: undefined };
}

interface BundledRuntime { version: string; executable: string; cli: string; }
/** Read the shipped private Node + pi without freezing the exact version: a new desktop
 *  release ships a new bundled pi, and the stamp only validates platform/arch fitness. */
function discoverBundled(runtimeDir: string): BundledRuntime | undefined {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(runtimeDir, 'node_modules/@earendil-works/pi-coding-agent/package.json'), 'utf8'));
    const executable = path.join(runtimeDir, 'node_modules/node/bin', process.platform === 'win32' ? 'node.exe' : 'node');
    const cli = path.join(runtimeDir, 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js');
    const stamp = JSON.parse(fs.readFileSync(path.join(runtimeDir, 'runtime.json'), 'utf8'));
    if (stamp.platform !== process.platform || stamp.arch !== process.arch) return undefined;
    fs.accessSync(executable, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
    fs.accessSync(cli);
    return { version: String(manifest.version || ''), executable, cli };
  } catch { /* A release without a complete runtime must not pretend it is usable. */ }
  return undefined;
}

/** Fixed private Node + pi; never launches a shell or installs global packages. */
export function discoverPi(prefs: PiPreferences = {}, env = process.env, runtimeDir = defaultRuntimeDir()): PiEnvironment {
  // 'auto' (the default) keeps desktop in lockstep with the user's local CLI: prefer it when
  // compatible, otherwise fall back to the frozen bundled runtime. Explicit bundled/system/custom
  // modes still let the user pin a source; only the default flipped from 'bundled' to 'auto'.
  const requestedRuntime = prefs.runtime ?? (prefs.executable ? 'custom' : 'auto');
  const external = discoverExternalPi(requestedRuntime === 'custom' ? prefs : { ...prefs, executable: undefined }, env);
  /** 本地 CLI 的参数前缀（Windows .cmd → [cli.js]）：packageInstall/upgradeLocalPi 复用。 */
  const systemLaunchArgs: string[] | undefined = external.launchArgs;
  const bundled = discoverBundled(runtimeDir);
  const wantExternal = requestedRuntime === 'system' || requestedRuntime === 'custom' ||
    (requestedRuntime === 'auto' && external.supported);

  // Branch 1: use the local CLI (preferred under 'auto', or explicitly requested).
  if (wantExternal) {
    if (external.supported) {
      return { ...external, runtime: requestedRuntime === 'custom' ? 'custom' : 'system', requestedRuntime,
        customExecutable: prefs.executable, fallback: false,
        systemVersion: external.version, systemExecutable: external.executable, systemSupported: external.supported,
        systemLaunchArgs, bundledVersion: bundled?.version ?? null };
    }
    // Explicit system/custom but local CLI unusable: fall back to bundled if we can.
    if (bundled) {
      return { ...external, executable: bundled.executable, version: bundled.version, supported: true,
        runtime: 'bundled', requestedRuntime, launchArgs: [bundled.cli], customExecutable: prefs.executable, fallback: true,
        diagnostics: [...(requestedRuntime === 'custom'
          ? ['所选自定义 pi 不可用或版本不兼容，已回退内置 pi。']
          : ['本地 pi 不可用或版本不兼容，已回退内置 pi。升级本地 CLI 后可切换为「自动」。']), ...external.diagnostics],
        systemVersion: external.version, systemExecutable: external.executable, systemSupported: external.supported,
        systemLaunchArgs, bundledVersion: bundled.version };
    }
    return { ...external, runtime: requestedRuntime === 'custom' ? 'custom' : 'system', requestedRuntime,
      customExecutable: prefs.executable,
      systemVersion: external.version, systemExecutable: external.executable, systemSupported: external.supported,
      systemLaunchArgs, bundledVersion: null };
  }

  // Branch 2: bundled requested (or 'auto' with no compatible local CLI).
  if (bundled) {
    const autoFallback = requestedRuntime === 'auto' && !external.supported && !!external.executable;
    return { ...external, executable: bundled.executable, version: bundled.version, supported: true,
      runtime: 'bundled', requestedRuntime, launchArgs: [bundled.cli], customExecutable: prefs.executable,
      fallback: requestedRuntime !== 'bundled' || autoFallback,
        diagnostics: autoFallback
        ? [`本地 pi ${external.version} 不在兼容区间 [${PI_MIN_VERSION}, ${PI_MAX_TESTED})，已使用内置 pi ${bundled.version}；升级本地 CLI 后自动切换。`, ...external.diagnostics]
        : external.diagnostics,
      systemVersion: external.version, systemExecutable: external.executable, systemSupported: external.supported,
      systemLaunchArgs, bundledVersion: bundled.version };
  }

  // Branch 3: nothing usable. Under 'auto' with no local CLI this points the user at installing one.
  if (requestedRuntime === 'bundled') {
    return { ...external, executable: null, version: null, supported: false, runtime: 'bundled', requestedRuntime,
      diagnostics: ['内置运行时缺失或架构不匹配。开发环境请运行 pnpm runtime:prepare；安装版请重新安装匹配架构的安装包。'],
      systemVersion: external.version, systemExecutable: external.executable, systemSupported: external.supported,
      bundledVersion: null };
  }
  return { ...external, runtime: 'system', requestedRuntime,
    customExecutable: prefs.executable,
    systemVersion: external.version, systemExecutable: external.executable, systemSupported: external.supported,
    systemLaunchArgs, bundledVersion: null };
}
function defaultRuntimeDir() {
  const resources=(process as NodeJS.Process & {resourcesPath?:string}).resourcesPath;
  return resources && fs.existsSync(path.join(resources,'pi-runtime')) ? path.join(resources,'pi-runtime') : path.resolve(__dirname,'../../../resources/pi-runtime');
}
