import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PiEnvironment, PiPreferences } from '../../shared/pi';

export function expand(value: string): string { return path.resolve(value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value); }

/** Lowest pi version whose RPC protocol desktop understands. */
const PI_MIN_VERSION = '0.85.1';
/** Highest pi version this desktop release has been exercised against. Bump per release;
 *  a local CLI above this still launches but is flagged for the sync banner to review. */
const PI_MAX_TESTED = '0.90.0';

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

/** A local CLI version desktop will actually launch via RPC. Win32 RPC is not enabled. */
export function piVersionSupported(version: string | null): boolean {
  if (!version) return false;
  if (process.platform === 'win32') return false;
  return compareVersion(version, PI_MIN_VERSION) >= 0 && compareVersion(version, PI_MAX_TESTED) < 0;
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
  for (const candidate of candidates) {
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
      executable = candidate;
      let dir = path.dirname(fs.realpathSync(candidate));
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
  return { executable, version, supported, agentDir, sessionDirs, diagnostics, runtime: undefined, requestedRuntime: undefined, launchArgs: undefined, customExecutable: undefined, fallback: undefined };
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
  const bundled = discoverBundled(runtimeDir);
  const wantExternal = requestedRuntime === 'system' || requestedRuntime === 'custom' ||
    (requestedRuntime === 'auto' && external.supported);

  // Branch 1: use the local CLI (preferred under 'auto', or explicitly requested).
  if (wantExternal) {
    if (external.supported) {
      return { ...external, runtime: requestedRuntime === 'custom' ? 'custom' : 'system', requestedRuntime,
        customExecutable: prefs.executable, fallback: false,
        systemVersion: external.version, systemExecutable: external.executable, systemSupported: external.supported,
        bundledVersion: bundled?.version ?? null };
    }
    // Explicit system/custom but local CLI unusable: fall back to bundled if we can.
    if (bundled) {
      return { ...external, executable: bundled.executable, version: bundled.version, supported: true,
        runtime: 'bundled', requestedRuntime, launchArgs: [bundled.cli], customExecutable: prefs.executable, fallback: true,
        diagnostics: [...(requestedRuntime === 'custom'
          ? ['所选自定义 pi 不可用或版本不兼容，已回退内置 pi。']
          : ['本地 pi 不可用或版本不兼容，已回退内置 pi。升级本地 CLI 后可切换为「自动」。']), ...external.diagnostics],
        systemVersion: external.version, systemExecutable: external.executable, systemSupported: external.supported,
        bundledVersion: bundled.version };
    }
    return { ...external, runtime: requestedRuntime === 'custom' ? 'custom' : 'system', requestedRuntime,
      customExecutable: prefs.executable,
      systemVersion: external.version, systemExecutable: external.executable, systemSupported: external.supported,
      bundledVersion: null };
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
      bundledVersion: bundled.version };
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
    bundledVersion: null };
}
function defaultRuntimeDir() {
  const resources=(process as NodeJS.Process & {resourcesPath?:string}).resourcesPath;
  return resources && fs.existsSync(path.join(resources,'pi-runtime')) ? path.join(resources,'pi-runtime') : path.resolve(__dirname,'../../../resources/pi-runtime');
}
