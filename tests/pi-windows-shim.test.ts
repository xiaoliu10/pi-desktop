import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseWindowsShim, windowsLaunchTarget, piVersionSupported, findNodeOnPath } from '../src/main/pi/environment';

/**
 * #168 Windows 本机 npm pi 检测不到 / 起不来。
 *
 * 真机实测（2026-11-02，Windows 10 / Node v22.11.0）：
 *  - Node 直接 spawn `.cmd`（无 shell）→ **EINVAL**（CVE-2024-27980，Node ≥18.20.2/
 *    20.12.2/21.7.3 起禁止未声明 shell 就 spawn .cmd/.bat）。桌面主进程走的正是这条路。
 *  - spawn `.cmd` + shell:true → exit=1 无输出（受 PATH 干扰，不可靠）。
 *  - spawn(node.exe, [cli.js]) shell:false → 正常，空格路径 C:\Program Files\nodejs 同样通过。
 *
 * 因此 Windows 必须：where.exe 找到 .cmd → 解析出 node 与 js 入口 → 直接 spawn node。
 * 且 `piVersionSupported` 不能因为平台是 win32 就一律判不支持（此前 return false，
 * 本地 CLI 永远不会被自动选中，用户只能永远用内置 pi）。
 */

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(p => { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ } }));
const tmp = () => { const r = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-win-')); roots.push(r); return r; };

/** npm 官方 cmd-shim longProg 分支模板（node.exe 与 .cmd 同目录，即 C:\Program Files\nodejs 布局）。 */
const NPM_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js" %*',
].join('\r\n');

/** 老版 cmd-shim（无 longProg 分支）：直接调 node 命令。 */
const LEGACY_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  'node  "%dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js" %*',
].join('\r\n');

describe('parseWindowsShim', () => {
  it('extracts node.exe and the js entry from a standard npm cmd-shim', () => {
    const root = tmp();
    const js = path.join(root, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js');
    fs.mkdirSync(path.dirname(js), { recursive: true });
    fs.writeFileSync(js, '');
    const shim = path.join(root, 'pi.cmd');
    fs.writeFileSync(shim, NPM_SHIM);

    const parsed = parseWindowsShim(shim);
    expect(parsed).not.toBeNull();
    expect(parsed!.js.toLowerCase()).toBe(js.toLowerCase());
    // node.exe 与 shim 同目录且存在 → 解析出绝对路径
    const node = path.join(root, 'node.exe');
    fs.writeFileSync(node, '');
    const parsed2 = parseWindowsShim(shim);
    expect(parsed2!.node?.toLowerCase()).toBe(node.toLowerCase());
  });

  it('falls back to bare `node` when the shim does not pin node.exe next to itself', () => {
    const root = tmp();
    const js = path.join(root, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js');
    fs.mkdirSync(path.dirname(js), { recursive: true });
    fs.writeFileSync(js, '');
    const shim = path.join(root, 'pi.cmd');
    fs.writeFileSync(shim, LEGACY_SHIM);

    const parsed = parseWindowsShim(shim);
    expect(parsed).not.toBeNull();
    expect(parsed!.js.toLowerCase()).toBe(js.toLowerCase());
    expect(parsed!.node).toBeNull(); // 交给 PATH 上的 node 解析
  });

  it('returns null for a shim that points at no resolvable js entry', () => {
    const root = tmp();
    const shim = path.join(root, 'pi.cmd');
    // npm 的 .cmd 也可能调用 .exe；拿不到 js 时必须明说解析失败，不能猜。
    fs.writeFileSync(shim, '@ECHO off\r\n"%~dp0\\pi.exe" %*\r\n');
    expect(parseWindowsShim(shim)).toBeNull();
  });

  it('returns null when the file is missing or unreadable', () => {
    expect(parseWindowsShim(path.join(tmp(), 'nope.cmd'))).toBeNull();
  });

  it('returns null when the shim names a cli.js that does not exist', () => {
    // 解析出路径不等于可执行：shim 指向一个已被删掉的安装时必须判失败，
    // 否则会把不存在的 js 交给 node，表现为「版本未知」而不是明确的诊断。
    const root = tmp();
    const shim = path.join(root, 'pi.cmd');
    fs.writeFileSync(shim, NPM_SHIM); // 有 %dp0%\...cli.js，但文件不存在
    expect(parseWindowsShim(shim)).toBeNull();
  });
});

describe('windowsLaunchTarget', () => {
  it('launches node + cli.js instead of the .cmd (avoids CVE-2024-27980 EINVAL)', () => {
    const root = tmp();
    const js = path.join(root, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js');
    fs.mkdirSync(path.dirname(js), { recursive: true });
    fs.writeFileSync(js, '');
    const node = path.join(root, 'node.exe');
    fs.writeFileSync(node, '');
    const shim = path.join(root, 'pi.cmd');
    fs.writeFileSync(shim, NPM_SHIM);

    const target = windowsLaunchTarget(shim, process.execPath);
    expect(target.command.toLowerCase()).toBe(node.toLowerCase());
    expect(target.args).toEqual([js]);
    expect(target.shell).toBe(false);
  });

  it('uses the desktop node as the interpreter when the shim relies on PATH', () => {
    const root = tmp();
    const js = path.join(root, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js');
    fs.mkdirSync(path.dirname(js), { recursive: true });
    fs.writeFileSync(js, '');
    const shim = path.join(root, 'pi.cmd');
    fs.writeFileSync(shim, LEGACY_SHIM);

    const target = windowsLaunchTarget(shim, 'C:\\app\\node.exe');
    expect(target.command).toBe('C:\\app\\node.exe');
    expect(target.args).toEqual([js]);
    expect(target.shell).toBe(false);
  });

  it('returns null (caller must fall back to bundled) when the shim cannot be parsed', () => {
    const root = tmp();
    const shim = path.join(root, 'pi.cmd');
    fs.writeFileSync(shim, '@ECHO off\r\n"%~dp0\\pi.exe" %*\r\n');
    expect(windowsLaunchTarget(shim, 'C:\\app\\node.exe')).toBeNull();
  });
});

describe('piVersionSupported on Windows', () => {
  it('no longer blanket-rejects win32 (local npm pi is a supported source now)', () => {
    // 回归：此前实现里 `if (process.platform === 'win32') return false;`，
    // 本地 pi 永远不被选中，用户只能永远用内置 pi（#168 的直接成因之一）。
    const src = fs.readFileSync(path.join(__dirname, '../src/main/pi/environment.ts'), 'utf8');
    const body = src.slice(src.indexOf('export function piVersionSupported'));
    const fn = body.slice(0, body.indexOf('\n}'));
    expect(fn).not.toMatch(/process\.platform\s*===\s*['"]win32['"]\s*\)\s*return false/);
  });

  it('still applies the version window', () => {
    expect(piVersionSupported('1.4.0')).toBe(true);
    expect(piVersionSupported('0.80.0')).toBe(false);
    expect(piVersionSupported(null)).toBe(false);
  });
});

describe('discoverPi wired to Windows shims', () => {
  it('turns a .cmd pi into node+cli.js launch config (not the shim itself)', () => {
    // 端到端：模拟 fubin 的 C:\Program Files\nodejs 布局（node.exe 与 pi.cmd 同级）。
    const root = tmp();
    const pkg = path.join(root, 'node_modules', '@earendil-works', 'pi-coding-agent');
    fs.mkdirSync(path.join(pkg, 'dist', 'bundle'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.4.0' }));
    const js = path.join(pkg, 'dist', 'bundle', 'cli.js');
    fs.writeFileSync(js, '');
    const node = path.join(root, 'node.exe');
    fs.writeFileSync(node, '');
    const shim = path.join(root, 'pi.cmd');
    fs.writeFileSync(shim, NPM_SHIM);

    const target = windowsLaunchTarget(shim, process.execPath);
    expect(target).not.toBeNull();
    // 关键：绝不能是 .cmd 本身（Node spawn .cmd → EINVAL）
    expect(target!.command.toLowerCase()).not.toContain('.cmd');
    expect(target!.args[0].toLowerCase()).toBe(js.toLowerCase());
  });
});

describe('Windows: 解释器选择与 CLI 参数前缀（Copilot review #185）', () => {
  it('never falls back to process.execPath (Electron) — resolves a real node on PATH', () => {
    // RPC 启动会删除 ELECTRON_RUN_AS_NODE；若把 process.execPath 当 node，
    // Windows 上启动的是 Desktop 自己的 Electron，不是 pi。
    const root = tmp();
    const js = path.join(root, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js');
    fs.mkdirSync(path.dirname(js), { recursive: true });
    fs.writeFileSync(js, '');
    const shim = path.join(root, 'pi.cmd');
    fs.writeFileSync(shim, LEGACY_SHIM); // 不 pin node.exe → 需要外部解释器

    // PATH 上有真 node → 用它
    const binDir = path.join(root, 'bin');
    fs.mkdirSync(binDir);
    const realNode = path.join(binDir, process.platform === 'win32' ? 'node.exe' : 'node');
    fs.writeFileSync(realNode, '', { mode: 0o755 });
    const target = windowsLaunchTarget(shim, undefined, { PATH: binDir });
    expect(target?.command).toBe(realNode);

    // PATH 上没有 node → 明确返回 null（让调用方回退内置），绝不拿 Electron 顶替
    expect(windowsLaunchTarget(shim, undefined, { PATH: path.join(root, 'empty') })).toBeNull();
  });

  it('findNodeOnPath finds node.exe on Windows-style PATH', () => {
    const root = tmp();
    const a = path.join(root, 'a');
    const b = path.join(root, 'b');
    fs.mkdirSync(a); fs.mkdirSync(b);
    const node = path.join(b, 'node.exe');
    fs.writeFileSync(node, '');
    expect(findNodeOnPath({ PATH: [a, b].join(path.delimiter) }, 'win32')).toBe(node);
    expect(findNodeOnPath({ PATH: a }, 'win32')).toBeNull();
  });

  it('packageInstall/upgradeLocalPi 必须在子命令前拼 launchArgs', () => {
    // 否则 Windows 上执行的是 `node.exe install <pkg>`，node 把 install 当脚本路径。
    const src = fs.readFileSync(path.join(__dirname, '../src/main/pi/host.ts'), 'utf8');
    const upgrade = src.slice(src.indexOf('upgradeLocalPi'));
    expect(upgrade.slice(0, 2000)).toMatch(/systemLaunchArgs[\s\S]{0,80}'update',\s*'self'/);
    expect(src).toMatch(/installPackage\([^)]*launchArgs/);
    const pkgs = fs.readFileSync(path.join(__dirname, '../src/main/pi/pi-packages.ts'), 'utf8');
    expect(pkgs).toMatch(/\.\.\.launchArgs,\s*action,\s*source/);
  });
});
