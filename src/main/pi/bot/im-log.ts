import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** [im-bot] 日志统一出口：console.error（dev 可见）+ 追加落盘。
 *  此前只写 console.error——Finder/Dock 启动的 Electron 主进程 stderr 不可见，
 *  而既有 pi-stderr.log 是 pi 子进程的 stderr（rpc-client.ts 落盘），钉钉排障
 *  一直失明（2026-10-18 实测：连接活着但日志零条，无法定位断点）。 */
const LOG_DIR = path.join(os.homedir(), 'Library', 'Logs', 'PI Desktop');
const LOG_FILE = path.join(LOG_DIR, 'im-bot.log');

export function imLog(line: string): void {
  console.error(`[im-bot] ${line}`);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`);
  } catch { /* 落盘失败不影响通道 */ }
}
