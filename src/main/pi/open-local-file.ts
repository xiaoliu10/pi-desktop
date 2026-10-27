import fs from 'node:fs';
import path from 'node:path';

export interface OpenLocalFileDeps {
  statSync?: (target: string) => { isDirectory(): boolean; isFile(): boolean };
  realpathSync?: (target: string) => string;
  /** Electron shell.openPath：成功返回 ''，失败返回错误描述。 */
  openPath?: (target: string) => Promise<string>;
  showItemInFolder?: (target: string) => void;
}

/**
 * 只有明确的文档型扩展名允许系统默认应用直接打开。
 * 聊天文本可能包含不可信链接：可执行载荷与未知类型一律只在文件管理器中显示，
 * 绝不因一次点击变成执行入口。
 */
const OPENABLE_DOCUMENT_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg',
  '.pdf', '.html', '.htm', '.md', '.markdown', '.txt',
  '.json', '.csv', '.log', '.yaml', '.yml', '.xml',
]);

// .app 在 macOS 上是目录，因此必须在 isDirectory() 短路前判定；
// 其余平台的可执行/安装载荷同样禁止直接打开。
const DANGEROUS_EXTENSIONS = new Set([
  '.app', '.command', '.exe', '.msi', '.bat', '.cmd', '.scr',
  '.dmg', '.pkg', '.sh',
]);

/** 真实路径落在 .app 包内（Contents/MacOS/x.png 这类同扩展名可执行文件）：
 *  只看扩展名会放行，故按路径段判定，包内一律不直接打开。 */
function isInsideAppBundle(target: string): boolean {
  return /\.app\/(?:Contents\/)?[^/]+/i.test(target.replace(/\\/g, '/'));
}

function isDangerousPath(target: string): boolean {
  return DANGEROUS_EXTENSIONS.has(path.extname(target.replace(/[/\\]+$/, '')).toLowerCase());
}

export async function openLocalFile(target: unknown, deps: OpenLocalFileDeps = {}): Promise<{ action: 'opened' | 'revealed' }> {
  if (typeof target !== 'string' || !target) throw new Error('文件路径无效');
  // UNC（//host/share 或 \\\\host\\share）在 Windows 上会发起 SMB 连接并发送凭据；
  // 聊天里的 file:// 链接可能来自不可信文本，统一按非本机路径拒绝。
  if (/^[\\/]{2}/.test(target)) throw new Error('不支持网络共享路径');
  if (target.includes('\0') || !path.isAbsolute(target)) throw new Error('文件路径无效');
  const statSync = deps.statSync ?? fs.statSync;
  const realpathSync = deps.realpathSync ?? fs.realpathSync;
  const openPath = deps.openPath ?? (async () => '');
  const showItemInFolder = deps.showItemInFolder ?? (() => {});

  let stat: { isDirectory(): boolean; isFile(): boolean };
  let realTarget: string;
  try {
    stat = statSync(target);
    // 以真实路径做扩展名判定：x.png 符号链接指向 Evil.app 时不能按链接名放行。
    realTarget = realpathSync(target);
  } catch {
    throw new Error('文件不存在或不可访问');
  }
  if (isDangerousPath(target) || isDangerousPath(realTarget) || isInsideAppBundle(realTarget)) {
    showItemInFolder(target);
    return { action: 'revealed' };
  }
  // 目录本身没有执行风险，直接在文件管理器里打开。
  const openable = stat.isDirectory() || (stat.isFile() && OPENABLE_DOCUMENT_EXTENSIONS.has(path.extname(realTarget).toLowerCase()));
  if (openable) {
    const failed = await openPath(target);
    if (failed) throw new Error(failed);
    return { action: 'opened' };
  }
  showItemInFolder(target);
  return { action: 'revealed' };
}
