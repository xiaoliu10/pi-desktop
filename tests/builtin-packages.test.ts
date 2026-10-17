import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_PACKAGES, ensureBuiltinPackages, builtinPackagesSeeded, markBuiltinPackagesSeeded } from '../src/main/pi/builtin-packages';

// 内置默认包：首次启动自动装 + 幂等 + 冲突（用户优先）+ 只补注册不重装。
// installPackage/registerPackage 打桩：本测试只验证决策逻辑，不真跑 pi install。
const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(p => fs.rmSync(p, { recursive: true, force: true })); vi.restoreAllMocks(); });

function setup(settings: Record<string, any> = {}, npmDeps: Record<string, string> = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'builtin-pkg-')));
  roots.push(root);
  const agentDir = path.join(root, 'agent'), dataDir = path.join(root, 'data');
  fs.mkdirSync(path.join(agentDir, 'npm'), { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify(settings, null, 2));
  fs.writeFileSync(path.join(agentDir, 'npm', 'package.json'), JSON.stringify({ dependencies: npmDeps }, null, 2));
  return { root, agentDir, dataDir };
}
const readPackages = (agentDir: string) => JSON.parse(fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8')).packages ?? [];
const readDesired = (dataDir: string) => JSON.parse(fs.readFileSync(path.join(dataDir, 'pi-desktop.json'), 'utf8')).piPackages ?? [];

describe('BUILTIN_PACKAGES manifest', () => {
  it('lists the four desktop-owned packages with version ranges', () => {
    const names = BUILTIN_PACKAGES.map(p => p.spec);
    expect(names).toContain('npm:@wengine-ai/pi-subagents@^0.79.1');
    expect(names).toContain('npm:@wengine-ai/pi-scoped-memory');
    expect(names).toContain('npm:@wengine-ai/pi-quality-prompt');
    expect(names).toContain('npm:@wengine-ai/pi-quality-gates@^0.1.0');
    expect(BUILTIN_PACKAGES.every(p => p.purpose.length > 0)).toBe(true);
  });
});

describe('ensureBuiltinPackages', () => {
  it('installs and registers every builtin on a fresh environment', async () => {
    const { agentDir, dataDir } = setup({ packages: [] });
    const report = await ensureBuiltinPackages('/fake/pi', agentDir, dataDir);
    // pi 可执行文件不存在 → installPackage 会失败并计入 failed（不静默）
    expect(report.failed.length).toBe(BUILTIN_PACKAGES.length);
    expect(readPackages(agentDir)).toEqual([]);
    expect(report.conflicts).toEqual([]);
  });

  it('registers already-installed deps without reinstalling', async () => {
    // npm 依赖已在（用户手动 pi install 过，注册被抹）→ 只补注册，不调 pi install。
    const { agentDir, dataDir } = setup({ packages: [] }, {
      '@wengine-ai/pi-subagents': '^0.79.1',
      '@wengine-ai/pi-scoped-memory': '^0.1.0',
      '@wengine-ai/pi-quality-prompt': '^0.1.0',
      '@wengine-ai/pi-quality-gates': '^0.1.0',
    });
    const report = await ensureBuiltinPackages('/fake/pi', agentDir, dataDir);
    expect(report.failed).toEqual([]);
    expect(report.installed).toHaveLength(BUILTIN_PACKAGES.length);
    expect(readPackages(agentDir).sort()).toEqual(BUILTIN_PACKAGES.map(p => p.spec).sort());
    expect(readDesired(dataDir).sort()).toEqual(BUILTIN_PACKAGES.map(p => p.spec).sort());
    expect(builtinPackagesSeeded(dataDir)).toBe(false);
    markBuiltinPackagesSeeded(dataDir);
    expect(builtinPackagesSeeded(dataDir)).toBe(true);
  });

  it('skips already-registered specs (idempotent)', async () => {
    const specs = BUILTIN_PACKAGES.map(p => p.spec);
    const { agentDir, dataDir } = setup({ packages: specs }, Object.fromEntries(specs.map(s => [s.slice(5).split('@')[0]!, '^1.0.0'])));
    const report = await ensureBuiltinPackages('/fake/pi', agentDir, dataDir);
    expect(report.alreadyRegistered).toHaveLength(BUILTIN_PACKAGES.length);
    expect(report.installed).toEqual([]);
    expect(report.conflicts).toEqual([]);
    expect(readPackages(agentDir)).toHaveLength(BUILTIN_PACKAGES.length);
  });

  it('reports a same-capability conflict and never replaces the user choice', async () => {
    // 用户装了上游 pi-subagents（不同 npm 名、同一功能域）→ desktop 不擅自替换，报告冲突。
    // 其余三个已在 npm 依赖里（模拟用户手动装过），只补注册——不触发 pi install。
    const { agentDir, dataDir } = setup({ packages: ['npm:pi-subagents'] }, {
      'pi-subagents': '^0.78.0',
      '@wengine-ai/pi-scoped-memory': '^0.1.0',
      '@wengine-ai/pi-quality-prompt': '^0.1.0',
      '@wengine-ai/pi-quality-gates': '^0.1.0',
    });
    const report = await ensureBuiltinPackages('/fake/pi', agentDir, dataDir);
    expect(report.conflicts).toHaveLength(1);
    expect(report.conflicts[0]).toMatchObject({ builtin: 'npm:@wengine-ai/pi-subagents@^0.79.1', existing: 'npm:pi-subagents' });
    expect(report.conflicts[0]!.purpose).toContain('子代理');
    // 用户的选择原样保留，builtin 没被塞进去
    expect(readPackages(agentDir)).toContain('npm:pi-subagents');
    expect(readPackages(agentDir)).not.toContain('npm:@wengine-ai/pi-subagents@^0.79.1');
    // 其余三个不冲突的照常补注册
    expect(report.installed).toHaveLength(3);
    expect(report.failed).toEqual([]);
    expect(readPackages(agentDir)).toHaveLength(4);
  });

  it('tolerates a missing settings.json (fresh agent dir)', async () => {
    const { agentDir, dataDir } = setup();
    fs.rmSync(path.join(agentDir, 'settings.json'));
    const report = await ensureBuiltinPackages('/fake/pi', agentDir, dataDir, {
      // 让 installPackage 可跑：不打桩时它 exec 一个不存在的可执行文件 → 计入 failed，不抛。
    });
    expect(Array.isArray(report.failed)).toBe(true);
    expect(report.conflicts).toEqual([]);
  });
});
