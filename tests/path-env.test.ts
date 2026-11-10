import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { augmentProcessPath, ensureGuiPath, DARWIN_PATH_CANDIDATES } from '../src/main/path-env';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((p) => fs.rmSync(p, { recursive: true, force: true })));

/** 用临时目录伪造「存在的候选路径」，返回 {env, existing}。 */
function darwinEnv(initialPath: string | undefined, existing: string[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'path-env-'));
  roots.push(root);
  const real = new Map<string, string>();
  for (const rel of existing) {
    const full = path.join(root, rel);
    fs.mkdirSync(full, { recursive: true });
    real.set(rel, full);
  }
  const stat = (p: string) => fs.statSync(p);
  // 把候选目录重写到临时目录下的同名结构
  const candidates = DARWIN_PATH_CANDIDATES.map((rel) => path.join(root, rel));
  const env: NodeJS.ProcessEnv = initialPath === undefined ? {} : { PATH: initialPath };
  return { env, root, real, stat, candidates };
}

it('darwin: appends existing homebrew/local bin dirs to the minimal Finder PATH', () => {
  const { env, stat, candidates } = darwinEnv('/usr/bin:/bin:/usr/sbin:/sbin', ['opt/homebrew/bin', 'usr/local/bin']);
  const homebrew = candidates[0];
  const usrLocal = candidates.find((c) => c.endsWith('usr/local/bin'))!;
  const result = augmentProcessPath('darwin', env, stat, candidates);
  const dirs = result.split(':');
  // 系统四目录原样保留且顺序在前
  expect(dirs.slice(0, 4)).toEqual(['/usr/bin', '/bin', '/usr/sbin', '/sbin']);
  // 存在的候选目录被追加
  expect(dirs).toContain(homebrew);
  expect(dirs).toContain(usrLocal);
  // 这正是修复目标：env node shebang 的语言服务器现在能在 PATH 里找到 node
  expect(result).not.toBe('/usr/bin:/bin:/usr/sbin:/sbin');
});

it('darwin: never appends candidate directories that do not exist on disk', () => {
  const { env, stat, candidates } = darwinEnv('/usr/bin:/bin', ['opt/homebrew/bin']);
  const homebrew = candidates[0];
  const usrLocal = candidates.find((c) => c.endsWith('usr/local/bin'))!;
  const result = augmentProcessPath('darwin', env, stat, candidates);
  const dirs = result.split(':');
  expect(dirs).toContain(homebrew);
  // usr/local/bin 未创建 → 不得出现
  expect(dirs).not.toContain(usrLocal);
});

it('darwin: idempotent — a second call changes nothing and never duplicates entries', () => {
  const { env, stat, candidates } = darwinEnv('/usr/bin:/bin', ['opt/homebrew/bin', 'usr/local/bin', '.local/bin']);
  const first = augmentProcessPath('darwin', env, stat, candidates);
  const once = first.split(':');
  const second = augmentProcessPath('darwin', { PATH: first }, stat, candidates);
  expect(second).toBe(first);
  for (const dir of once) expect(second.split(':').filter((d) => d === dir)).toHaveLength(1);
});

it('darwin: leaves an already-complete PATH untouched (no duplicate append)', () => {
  const { env, stat, candidates } = darwinEnv(undefined, ['opt/homebrew/bin']);
  const full = ['/usr/bin', candidates[0]].join(':');
  env.PATH = full;
  expect(augmentProcessPath('darwin', env, stat, candidates)).toBe(full);
});

it('darwin: builds a PATH when the GUI process launched with PATH unset', () => {
  const { env, stat, candidates } = darwinEnv(undefined, ['opt/homebrew/bin']);
  const result = augmentProcessPath('darwin', env, stat, candidates);
  expect(result.split(':')).toContain(candidates[0]);
});

it('non-darwin platforms return the PATH unchanged', () => {
  const { env, stat, candidates } = darwinEnv('/usr/bin:/bin', ['opt/homebrew/bin']);
  expect(augmentProcessPath('linux', env, stat, candidates)).toBe('/usr/bin:/bin');
  expect(augmentProcessPath('win32', env, stat, candidates)).toBe('/usr/bin:/bin');
});

it('a broken stat for one candidate does not remove the others', () => {
  const { env, stat, candidates } = darwinEnv('/usr/bin:/bin', ['opt/homebrew/bin', 'usr/local/bin']);
  const usrLocal = candidates.find((c) => c.endsWith('usr/local/bin'))!;
  const flakyStat = (p: string) => {
    if (p === usrLocal) throw new Error('ENOENT');
    return stat(p);
  };
  const result = augmentProcessPath('darwin', env, flakyStat, candidates);
  expect(result.split(':')).toContain(candidates[0]);
  expect(result.split(':')).not.toContain(usrLocal);
});

it('ensureGuiPath writes the augmented PATH back onto process.env (child-process inheritance)', () => {
  // 模拟 Finder 启动：先把进程 PATH 压成系统最小集，验证 ensureGuiPath 写回后
  // 子进程以 {...process.env} 组装 env 时能拿到 homebrew 路径（env node 可解析）。
  const saved = process.env.PATH;
  const originalCandidates = [...DARWIN_PATH_CANDIDATES];
  try {
    process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
    const result = ensureGuiPath('darwin');
    expect(process.env.PATH).toBe(result);
    // 本机 /opt/homebrew/bin 真实存在（CI 缺失也不报错，只断言系统目录仍在）
    expect(result.startsWith('/usr/bin:/bin:/usr/sbin:/sbin')).toBe(true);
    if (fs.existsSync('/opt/homebrew/bin')) {
      expect(result.split(':')).toContain('/opt/homebrew/bin');
      // 模拟 backend.ts:361 的 spawn env 组装
      const spawnEnv = { ...process.env, PI_DESKTOP_GENERATION: 'g1' };
      expect(spawnEnv.PATH).toBe(result);
      expect(spawnEnv.PATH.split(':')).toContain('/opt/homebrew/bin');
    }
    void originalCandidates;
  } finally {
    process.env.PATH = saved;
  }
});
