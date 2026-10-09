import fs from 'node:fs';

// 会话文件读取上限。超限不再「整个会话从侧栏消失」——那正是 96MB 的 ashare
// 主会话 2026-10-09 从侧栏消失的根因（用户看到「该项目还没有会话」）。
// 超限会话降级为「元数据可见」：列表/侧栏照常显示（名字/大小/时间），
// history() 读取全量内容时才给出可执行的错误提示。
export const MAX_SESSION = 512 * 1024 * 1024;

export interface SessionIndexWarning { message: string }

export class OversizedSessionError extends Error {
  constructor(public readonly file: string, public readonly size: number) {
    super(`会话文件已达 ${Math.round(size / 1024 / 1024)} MiB，超过 ${Math.round(MAX_SESSION / 1024 / 1024)} MiB 读取上限；可浏览列表但无法载入完整历史。`);
    this.name = 'OversizedSessionError';
  }
}

/** 只读文件头两行：版本/cwd/parentSession/首条用户消息（列表显示用），
 *  不触碰正文，O(行数) 而非 O(字节)。 */
export function sessionStub(file: string): { header: Record<string, any>; firstUserText: string } | undefined {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.allocUnsafe(256 * 1024);
      const read = fs.readSync(fd, buf, 0, buf.length, 0);
      const text = buf.toString('utf8', 0, read);
      const lines = text.split('\n').filter(l => l.trim());
      let header: Record<string, any> = {};
      let firstUserText = '';
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry?.type === 'session' && !header.id) header = entry;
          else if (entry?.type === 'message' && entry.message?.role === 'user' && !firstUserText) {
            const c = entry.message.content;
            firstUserText = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' ') : '';
          }
          if (header.id && firstUserText) break;
        } catch { /* 半行/损坏行跳过 */ }
      }
      return { header, firstUserText };
    } finally { fs.closeSync(fd); }
  } catch { return undefined; }
}
