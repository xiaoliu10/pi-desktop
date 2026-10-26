import fs from 'node:fs';
import path from 'node:path';

export interface OpenLocalFileDeps {
  statSync?: (target: string) => { isDirectory(): boolean; isFile(): boolean };
  /** Electron shell.openPath：成功返回 ''，失败返回错误描述。 */
  openPath?: (target: string) => Promise<string>;
  showItemInFolder?: (target: string) => void;
}

/**
 * 只有明确的文档型扩展名允许系统默认应用直接打开。
 * 聊天文本可能包含不可信链接：.app/.command/.exe 等可执行载荷与未知类型
 * 一律只在文件管理器中显示，绝不因一次点击变成执行入口。
 */
const OPENABLE_DOCUMENT_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg',
  '.pdf', '.html', '.htm', '.md', '.markdown', '.txt',
  '.json', '.csv', '.log', '.yaml', '.yml', '.xml',
]);

export async function openLocalFile(target: unknown, deps: OpenLocalFileDeps = {}): Promise<{ action: 'opened' | 'revealed' }> {
  if (typeof target !== 'string' || !target || target.includes('\0') || !path.isAbsolute(target)) {
    throw new Error('文件路径无效');
  }
  const statSync = deps.statSync ?? fs.statSync;
  const openPath = deps.openPath ?? (async () => '');
  const showItemInFolder = deps.showItemInFolder ?? (() => {});
  let stat: { isDirectory(): boolean; isFile(): boolean };
  try {
    stat = statSync(target);
  } catch {
    throw new Error('文件不存在或不可访问');
  }
  // 目录本身没有执行风险，直接在文件管理器里打开。
  const openable = stat.isDirectory() || (stat.isFile() && OPENABLE_DOCUMENT_EXTENSIONS.has(path.extname(target).toLowerCase()));
  if (openable) {
    const failed = await openPath(target);
    if (failed) throw new Error(failed);
    return { action: 'opened' };
  }
  showItemInFolder(target);
  return { action: 'revealed' };
}
