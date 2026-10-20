import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// prune-dist.mjs 的 dist/mac-arm64 清理回归。
// 背景（2026-10-19 实测事故）：electron-builder 每次打包都重新生成 dist/mac-arm64/，
// 而它不在 ARTIFACT_PATTERN 的文件集合里；sync-release.mjs 只在 `pnpm dist` 链路里删它，
// 直接调 electron-builder 打发布包时不删 → dist 与 release 各留一个同名 .app，
// LaunchServices 按路径各注册一份 → 启动台出现两个「PI Desktop」。
// 本测试钉住：无论 dist 里有没有安装包，mac-arm64 都必须被清掉。
const root = path.resolve(__dirname, '..');
const script = path.join(root, 'scripts/prune-dist.mjs');

/** 在临时目录造一个假仓库（含 package.json + dist），用 --root 跑脚本。 */
function runPrune(files: Array<{ rel: string; bytes?: number }>) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'prune-dist-'));
  const dist = path.join(tmp, 'dist');
  mkdirSync(dist, { recursive: true });
  for (const file of files) {
    const full = path.join(dist, file.rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, Buffer.alloc(file.bytes ?? 16, 'x'));
  }
  writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ version: '0.1.30' }));
  const out = execFileSync('node', [script, '--root', tmp], { encoding: 'utf8' });
  return { tmp, dist, out };
}

describe('prune-dist mac-arm64 cleanup', () => {
  it('removes dist/mac-arm64 even when no installer artifacts exist', () => {
    // 事故现场复刻：dist 里只有一个 mac-arm64 目录，没有任何安装包文件。
    const { tmp, dist, out } = runPrune([{ rel: 'mac-arm64/PI Desktop.app/Contents/MacOS/PI Desktop', bytes: 2048 }]);
    try {
      expect(out).toContain('mac-arm64');
      expect(existsSync(path.join(dist, 'mac-arm64'))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('keeps cleaning installer artifacts while also removing mac-arm64', () => {
    const { tmp, dist, out } = runPrune([
      { rel: 'mac-arm64/PI Desktop.app/Contents/MacOS/PI Desktop', bytes: 1024 },
      { rel: 'PI Desktop-0.1.29-arm64.dmg', bytes: 512 },
      { rel: 'PI Desktop-0.1.30-arm64.dmg', bytes: 512 },
    ]);
    try {
      expect(existsSync(path.join(dist, 'mac-arm64'))).toBe(false);
      // 旧版本安装包照旧清掉
      expect(existsSync(path.join(dist, 'PI Desktop-0.1.29-arm64.dmg'))).toBe(false);
      // 当前版本安装包必须保留
      expect(existsSync(path.join(dist, 'PI Desktop-0.1.30-arm64.dmg'))).toBe(true);
      expect(out).toMatch(/释放/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('does not touch mac-arm64 under --dry-run', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'prune-dist-dry-'));
    const dist = path.join(tmp, 'dist');
    mkdirSync(path.join(dist, 'mac-arm64/PI Desktop.app/Contents/MacOS'), { recursive: true });
    writeFileSync(path.join(dist, 'mac-arm64/PI Desktop.app/Contents/MacOS/PI Desktop'), 'x');
    writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ version: '0.1.30' }));
    try {
      const out = execFileSync('node', [script, '--root', tmp, '--dry-run'], { encoding: 'utf8' });
      expect(out).toContain('将删除 dist/mac-arm64/');
      // 试运行必须原样保留
      expect(existsSync(path.join(dist, 'mac-arm64'))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('is a no-op when dist has neither artifacts nor mac-arm64', () => {
    const { tmp, out } = runPrune([]);
    try {
      expect(out).not.toContain('mac-arm64');
      expect(out).toContain('保留');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
