import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExternalApp } from '../../shared/open-with';
import { canonical } from './session-index';

/**
 * 用外部应用打开当前项目目录。安全边界：
 * - 应用来自固定白名单（Finder/Terminal/JetBrains 系/VS Code），渲染端只能传 id；
 * - cwd 必须通过 authorizeProjectCwd（已添加项目 / 会话 / 运行中工作区）；
 * - 只 spawn /usr/bin/open，argv 数组传参，不经 shell。
 * 所有 OS 依赖都可注入，测试不需要 macOS 或 Electron。
 */
export interface OpenWithDeps {
  platform?: string;
  home?: string;
  existsSync?: (path: string) => boolean;
  /** Real system icon (Electron app.getFileIcon) as data URL; undefined when unavailable. */
  fileIcon?: (path: string) => Promise<string | undefined>;
  /** Spawn without a shell; must reject on launch failure. */
  run?: (file: string, args: string[]) => Promise<void>;
  /** Synchronous stat (default fs.statSync); used to validate cwd is an existing directory. */
  statSync?: (path: string) => { isDirectory(): boolean };
  /** Non-macOS fallback: open the folder in the system file manager (Electron shell.openPath). */
  openPath?: (path: string) => Promise<void>;
}

interface CatalogEntry { id: string; name: string; bundles: string[]; kind: ExternalApp['kind'] }

/** macOS 白名单：编辑器打开项目文件夹；Terminal 最后（打开外部终端窗口）。 */
const MAC_CATALOG: CatalogEntry[] = [
  { id: 'intellij-idea', name: 'IntelliJ IDEA', bundles: ['IntelliJ IDEA.app', 'IntelliJ IDEA CE.app'], kind: 'editor' },
  { id: 'webstorm', name: 'WebStorm', bundles: ['WebStorm.app'], kind: 'editor' },
  { id: 'pycharm', name: 'PyCharm', bundles: ['PyCharm.app', 'PyCharm CE.app'], kind: 'editor' },
  { id: 'vscode', name: 'Visual Studio Code', bundles: ['Visual Studio Code.app'], kind: 'editor' },
  { id: 'terminal', name: 'Terminal', bundles: ['Utilities/Terminal.app'], kind: 'terminal' },
];

const FINDER_PATH = '/System/Library/CoreServices/Finder.app';

export async function listExternalApps(deps: OpenWithDeps = {}): Promise<ExternalApp[]> {
  const platform = deps.platform ?? process.platform;
  // 其他平台安全回退：只暴露系统文件管理器一项。
  if (platform !== 'darwin') return [{ id: 'file-manager', name: 'File Manager', path: '', kind: 'finder' }];
  const exists = deps.existsSync ?? fs.existsSync;
  const home = deps.home ?? os.homedir();
  const dirs = ['/Applications', path.join(home, 'Applications'), '/System/Applications'];
  const apps: ExternalApp[] = [{ id: 'finder', name: 'Finder', path: FINDER_PATH, kind: 'finder' }];
  for (const entry of MAC_CATALOG) {
    const found = entry.bundles.flatMap(bundle => dirs.map(dir => path.join(dir, bundle))).find(candidate => exists(candidate));
    if (found) apps.push({ id: entry.id, name: entry.name, path: found, kind: entry.kind });
  }
  if (deps.fileIcon) {
    for (const app of apps) {
      try { app.icon = await deps.fileIcon(app.path); } catch { app.icon = undefined; }
    }
  }
  return apps;
}

/** Authorize a renderer-supplied directory against known projects / sessions / runs. Returns the canonical path. */
export function authorizeProjectCwd(cwd: unknown, known: string[]): string {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('项目路径无效');
  const real = canonical(cwd);
  if (!known.some(entry => canonical(entry) === real)) throw new Error('项目不存在，请刷新。');
  return real;
}

export async function openWithApp(cwd: string, appId: string, deps: OpenWithDeps = {}, apps?: ExternalApp[]): Promise<void> {
  if (typeof appId !== 'string' || typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('打开参数无效');
  const list = apps ?? await listExternalApps(deps);
  const app = list.find(entry => entry.id === appId);
  if (!app) throw new Error('未知的外部应用，请重新选择。');
  // cwd 必须存在且为目录（项目可能已被删除/移动）。statSync 可注入便于测试。
  const stat = deps.statSync ?? fs.statSync;
  let stats: { isDirectory(): boolean };
  try { stats = stat(cwd); } catch { throw new Error('项目目录不存在，请刷新。'); }
  if (!stats || !stats.isDirectory()) throw new Error('项目路径不是目录，请刷新。');
  if (app.id === 'file-manager') {
    if (!deps.openPath) throw new Error('当前环境不支持打开文件管理器。');
    return deps.openPath(cwd);
  }
  const run = deps.run ?? defaultRun;
  // Finder 直接 open 目录；其余用 -a 指定 bundle 路径（避免同名应用歧义）。Terminal 会在该目录开新窗口。
  return app.kind === 'finder' ? run('/usr/bin/open', [cwd]) : run('/usr/bin/open', ['-a', app.path, cwd]);
}

function defaultRun(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { shell: false, stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', code => (code === 0 ? resolve() : reject(new Error(`open 启动失败（退出码 ${code}）`))));
  });
}
