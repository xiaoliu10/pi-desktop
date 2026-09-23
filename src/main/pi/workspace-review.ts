import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { PiReview } from '../../shared/pi';
const exec = promisify(execFile);

/** Never read more than this per untracked file, and cap the list itself. */
const UNTRACKED_LIST_LIMIT = 300;
const UNTRACKED_READ_LIMIT = 512 * 1024;

function countLines(buf: Buffer): number {
  if (!buf.length) return 0;
  let lines = 0;
  for (const byte of buf) if (byte === 10) lines++;
  return buf[buf.length - 1] === 10 ? lines : lines + 1;
}

/** Line counts for untracked files so the Review tab can show them as created (+N). */
async function untrackedStats(root: string, paths: string[]): Promise<{ path: string; lines: number }[]> {
  const out: { path: string; lines: number }[] = [];
  for (const p of paths.slice(0, UNTRACKED_LIST_LIMIT)) {
    const fallback = { path: p, lines: 0 };
    try {
      const full = path.join(root, p);
      if (path.relative(root, full).startsWith('..')) { out.push(fallback); continue; }
      const st = await fs.promises.lstat(full);
      if (!st.isFile() || st.size > UNTRACKED_READ_LIMIT) { out.push(fallback); continue; }
      const buf = await fs.promises.readFile(full);
      if (buf.subarray(0, 8192).includes(0)) { out.push(fallback); continue; }
      out.push({ path: p, lines: countLines(buf) });
    } catch {
      out.push(fallback);
    }
  }
  return out;
}

export async function workspaceReview(cwd: string): Promise<PiReview> {
  const run = (args: string[]) => exec('git', ['-c', 'core.fsmonitor=false', ...args], { cwd, maxBuffer: 2 * 1024 * 1024, timeout: 10_000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  try {
    const root = (await run(['rev-parse', '--show-toplevel'])).stdout.trim();
    let baseline = 'HEAD';
    try { await run(['rev-parse', '--verify', 'HEAD']); } catch { baseline = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'; }
    const diff = (await run(['diff', '--no-ext-diff', '--no-textconv', baseline, '--', '.'])).stdout;
    const untracked = (await run(['ls-files', '--others', '--exclude-standard', '-z', '--', '.'])).stdout.split('\0').filter(Boolean);
    const untrackedFiles = await untrackedStats(root, untracked);
    return { root, baseline, diff, untracked, untrackedFiles, warning: '显示当前项目相对 Git 基线的全部净变化，包含原有及其他会话的改动；未跟踪文件按新增计入，仅统计文本行数。' };
  } catch {
    return { root: cwd, baseline: '', diff: '', untracked: [], untrackedFiles: [], warning: '无法读取 Git 差异：可能不是 Git 项目、目录不可用，或输出超过 2 MiB。未修改任何文件。' };
  }
}
