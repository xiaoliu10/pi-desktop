import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PiBackend } from '../src/main/pi/backend';
import { SessionIndex } from '../src/main/pi/session-index';
import { PiRpcClient } from '../src/main/pi/rpc-client';
import { detectPlanPackage } from '../src/main/pi/plan-package';
import { registerDesktopPlan, PLAN_TOOL_NAME } from '../extensions/desktop-policy/plan.mjs';

// v0.1.47 回归（用户实测「启动报错」）：desktop_update_plan 被双注册 →
// pi 在扩展加载阶段抛同名冲突直接退出，每个会话都起不来，渲染层只剩
// 「Cannot read properties of null (reading 'id')」。
//
// 根因是**加载顺序**：desktop-policy 是 backend 传入的第一个 -e 扩展，
// registerDesktopPlan 靠「运行时探测同名工具是否已注册」让位给 npm 包，
// 但探测发生在包加载之前，必然落空。而 #193 起 pi-plan-tool 进了
// BUILTIN_PACKAGES（必定被注册），冲突从偶发变成必然。
//
// 修法：让位判定提到 launch 层（与 detectThirdPartyAsk 同模式），
// 由 backend 探测「谁会提供这个工具」并通过 PI_DESKTOP_PLAN_PACKAGE 告知扩展。
// 保留的必须是 npm 包——TUI 与 GUI 共用同一份实现（用户 2026-11-09 裁定）。
const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(r => fs.rmSync(r, { recursive: true, force: true })); vi.unstubAllEnvs(); });

function agentDirWith(layout: { packages?: unknown[]; installed?: string[]; extensions?: string[]; autoload?: string[] }) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plan-provider-')));
  roots.push(dir);
  fs.mkdirSync(path.join(dir, 'npm'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ packages: layout.packages ?? [] }, null, 2));
  for (const name of layout.installed ?? []) {
    const pkgDir = path.join(dir, 'npm', 'node_modules', name);
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'index.mjs'), 'export default function () {}\n');
  }
  for (const name of layout.extensions ?? []) fs.mkdirSync(path.join(dir, 'extensions', name), { recursive: true });
  for (const name of layout.autoload ?? []) {
    const pkgDir = path.join(dir, 'npm', 'node_modules', name);
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name, pi: { extensions: ['./index.mjs'] } }));
  }
  return dir;
}

/** 记录 registerTool 调用的最小 pi 桩。 */
function fakePi(registered: string[] = []) {
  const calls: string[] = [];
  return {
    calls,
    pi: {
      registerTool: (tool: { name: string }) => { calls.push(tool.name); },
      getTools: () => registered.map(name => ({ name })),
    },
  };
}

describe('detectPlanPackage: 谁会提供 desktop_update_plan', () => {
  it('声明且真的装好了 → 由 npm 包提供', () => {
    const dir = agentDirWith({ packages: ['npm:@wengine-ai/pi-plan-tool@^0.0.1'], installed: ['@wengine-ai/pi-plan-tool'] });
    expect(detectPlanPackage(dir)).toEqual({ detected: true, source: 'npm:@wengine-ai/pi-plan-tool@^0.0.1' });
  });

  it('不带版本范围的声明同样识别', () => {
    const dir = agentDirWith({ packages: ['npm:@wengine-ai/pi-plan-tool'], installed: ['@wengine-ai/pi-plan-tool'] });
    expect(detectPlanPackage(dir).detected).toBe(true);
  });

  it('接受 {source} 对象形态的注册项', () => {
    const dir = agentDirWith({ packages: [{ source: 'npm:@wengine-ai/pi-plan-tool' }], installed: ['@wengine-ai/pi-plan-tool'] });
    expect(detectPlanPackage(dir).detected).toBe(true);
  });

  // 让位后如果包其实加载不了，desktop_update_plan 会整个消失（侧栏「进程」空掉、
  // --tools 里列了个不存在的工具）——比冲突更难排查。所以「声明了但没装」必须
  // 判为未检测到，让内置副本顶上（fail-open，与 plan.mjs 原设计意图一致）。
  it('声明了但没装进 node_modules → 不让位（内置副本兜底）', () => {
    const dir = agentDirWith({ packages: ['npm:@wengine-ai/pi-plan-tool@^0.0.1'] });
    expect(detectPlanPackage(dir)).toEqual({ detected: false });
  });

  it('识别手装到 extensions/ 目录的形态', () => {
    const dir = agentDirWith({ extensions: ['pi-plan-tool'] });
    expect(detectPlanPackage(dir)).toEqual({ detected: true, source: 'pi-plan-tool' });
  });

  it('识别 autoload 形态（无 settings.packages，靠 pi.extensions 清单）', () => {
    const dir = agentDirWith({ autoload: ['@wengine-ai/pi-plan-tool'] });
    expect(detectPlanPackage(dir).detected).toBe(true);
  });

  it('desktop-* 自己的扩展不算第三方提供方', () => {
    const dir = agentDirWith({ packages: ['npm:desktop-plan-tool'], extensions: ['desktop-plan-tool'], autoload: ['desktop-plan-tool'] });
    expect(detectPlanPackage(dir)).toEqual({ detected: false });
  });

  it('无关包不误判', () => {
    const dir = agentDirWith({ packages: ['npm:@wengine-ai/pi-subagents@^0.79.1'], installed: ['@wengine-ai/pi-subagents'] });
    expect(detectPlanPackage(dir)).toEqual({ detected: false });
  });

  it('settings.json 缺失或损坏时静默判无', () => {
    const dir = agentDirWith({});
    expect(detectPlanPackage(dir)).toEqual({ detected: false });
    fs.writeFileSync(path.join(dir, 'settings.json'), '{not json');
    expect(detectPlanPackage(dir)).toEqual({ detected: false });
    expect(detectPlanPackage(path.join(dir, 'nope'))).toEqual({ detected: false });
  });
});

describe('registerDesktopPlan: 内置副本让位', () => {
  it('launch 层判定包提供时不注册（PI_DESKTOP_PLAN_PACKAGE=1）', () => {
    vi.stubEnv('PI_DESKTOP_PLAN_PACKAGE', '1');
    const { calls, pi } = fakePi();
    registerDesktopPlan(pi);
    expect(calls).toEqual([]);
  });

  it('没有包时照常注册内置副本', () => {
    vi.stubEnv('PI_DESKTOP_PLAN_PACKAGE', '');
    const { calls, pi } = fakePi();
    registerDesktopPlan(pi);
    expect(calls).toEqual([PLAN_TOOL_NAME]);
  });

  it('运行时探测仍作为第二道防线：工具已注册就不重复注册', () => {
    vi.stubEnv('PI_DESKTOP_PLAN_PACKAGE', '');
    const { calls, pi } = fakePi([PLAN_TOOL_NAME]);
    registerDesktopPlan(pi);
    expect(calls).toEqual([]);
  });
});

describe('backend launch: 把提供方判定传给子进程', () => {
  async function launchEnv(layout: { packages?: unknown[]; installed?: string[] }) {
    const dir = agentDirWith(layout);
    const owned = path.join(dir, 'desktop'); fs.mkdirSync(owned);
    const backend = new PiBackend(
      { executable: process.execPath, version: '0.85.1', supported: true, agentDir: dir, sessionDirs: [dir], diagnostics: [] },
      new SessionIndex([owned], owned), owned,
      path.resolve('extensions/desktop-policy/index.mjs'), () => {},
    );
    let captured: NodeJS.ProcessEnv | undefined;
    backend.clientFactory = (_command, args, cwd, env) => {
      captured = env;
      return new PiRpcClient(process.execPath, [path.resolve('tests/fixtures/fake-pi.mjs'), ...args], cwd, env);
    };
    try {
      await backend.connect({ cwd: dir, trustProject: false, permission: 'ask' });
      return captured!;
    } finally { backend.dispose(); }
  }

  it('包已装 → 置 PI_DESKTOP_PLAN_PACKAGE=1，内置副本让位', async () => {
    const env = await launchEnv({ packages: ['npm:@wengine-ai/pi-plan-tool@^0.0.1'], installed: ['@wengine-ai/pi-plan-tool'] });
    expect(env.PI_DESKTOP_PLAN_PACKAGE).toBe('1');
  });

  it('没有包 → 不置标记，内置副本注册', async () => {
    const env = await launchEnv({ packages: [] });
    expect(env.PI_DESKTOP_PLAN_PACKAGE).toBeUndefined();
  });

  // env 从 process.env 展开而来：Desktop 若从某个已置该变量的 pi 会话里启动，
  // 陈旧值会让「没有包」的会话也跳过注册 → 清单工具整个消失。必须显式清掉。
  it('清掉继承来的陈旧标记', async () => {
    vi.stubEnv('PI_DESKTOP_PLAN_PACKAGE', '1');
    const env = await launchEnv({ packages: [] });
    expect(env.PI_DESKTOP_PLAN_PACKAGE).toBeUndefined();
  });
});
