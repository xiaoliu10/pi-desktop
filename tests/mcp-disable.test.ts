// pi ≥0.99 原生 MCP 适配全覆盖：
// ① mcp.json 迁移——覆盖层（disabledServers/enabledServers）折叠 + imports 物化 + per-entry enabled 标志；
// ② 启停写 per-entry enabled（pi 原生语义，desktop 与 pi 共用同一份文件）；
// ③ mcp-bridge 版本门——<0.99 按标志连接（旧 CLI 无原生 MCP），≥0.99 整体让位给 builtin:mcp。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PiHost } from '../src/main/pi/host';
import { SettingsService } from '../src/main/pi/settings-service';
import { piHasNativeMcp } from '../src/main/pi/environment';

const roots: string[] = [];
const hosts: PiHost[] = [];
const fakeMcp = path.resolve('tests/fixtures/fake-mcp.cjs');
const node = process.execPath;
// mcp-imports.cjs 在模块加载时解析 os.homedir()，必须在首次触发它之前替换 HOME。
const fakeHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-home-')));
process.env.HOME = fakeHome;
// codexoff 模拟「来源工具自己禁用了 enabled=false」的导入服务（真实案例：codex 的 computer-use）。
fs.writeFileSync(path.join(fakeHome, '.claude.json'), JSON.stringify({
  mcpServers: {
    fromclaude: { command: node, args: [fakeMcp] },
    claudeoff: { command: node, args: [fakeMcp] },
    selfoff: { command: node, args: [fakeMcp], disabled: true },
    sourceoff: { command: node, args: [fakeMcp], enabled: false },
  },
}));
// 相对路径归一化的探测目录：模拟 codex 把相对 command 写成 ./Tool.app/...、真实位置在子目录。
const toolBin = path.join(fakeHome, '.codex', 'plugins', 'MyTool.app', 'Contents', 'MacOS', 'toolbin');
fs.mkdirSync(path.dirname(toolBin), { recursive: true });
fs.writeFileSync(toolBin, '#!/bin/sh\n', { mode: 0o755 });

afterEach(() => {
  hosts.splice(0).forEach(h => h.dispose());
  roots.splice(0).forEach(p => fs.rmSync(p, { recursive: true, force: true }));
  delete process.env.PI_DESKTOP_PI_VERSION;
});

function setup() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-disable-')));
  roots.push(root);
  const agent = path.join(root, 'agent'), data = path.join(root, 'data'), project = path.join(root, 'project');
  fs.mkdirSync(agent); fs.mkdirSync(data); fs.mkdirSync(project);
  fs.writeFileSync(path.join(data, 'pi-desktop.json'), JSON.stringify({ agentDir: agent }));
  const host = new PiHost(data, path.resolve('extensions/desktop-policy/index.mjs'), () => {}, path.join(root, 'shared-skills'));
  hosts.push(host);
  const service = new SettingsService(host, data, path.resolve('extensions/desktop-policy'));
  return { root, agent, project, service, host };
}

describe('mcp.json 迁移（pi ≥0.99 原生语义）', () => {
  it('folds overlay lists and materializes imports into per-entry enabled flags, with a one-time backup', () => {
    const { agent, service } = setup();
    const file = path.join(agent, 'mcp.json');
    const legacy = {
      imports: ['claude-code'],
      mcpServers: { direct: { command: node, args: [fakeMcp] }, directoff: { command: node, args: [fakeMcp] }, selfoff: { command: node, args: [fakeMcp], disabled: true } },
      disabledServers: ['claudeoff', 'directoff'],
      enabledServers: ['sourceoff'],
    };
    fs.writeFileSync(file, JSON.stringify(legacy));
    const rows = service.snapshot().mcp;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(raw.imports).toBeUndefined();
    expect(raw.disabledServers).toBeUndefined();
    expect(raw.enabledServers).toBeUndefined();
    for (const name of ['fromclaude', 'claudeoff', 'selfoff', 'sourceoff', 'direct', 'directoff']) expect(raw.mcpServers[name]).toBeTruthy();
    expect(raw.mcpServers.claudeoff).toMatchObject({ enabled: false });
    expect(raw.mcpServers.directoff).toMatchObject({ enabled: false });
    expect(raw.mcpServers.selfoff).toMatchObject({ enabled: false });
    expect(raw.mcpServers.selfoff.disabled).toBeUndefined();
    expect(raw.mcpServers.sourceoff).toMatchObject({ enabled: true });
    expect(raw.mcpServers.direct.enabled).toBeUndefined();
    expect(fs.existsSync(file + '.bak-pre099')).toBe(true);
    expect(JSON.parse(fs.readFileSync(file + '.bak-pre099', 'utf8'))).toEqual(legacy);
    const by = (n: string) => rows.find(r => r.name === n)!;
    expect(by('fromclaude')).toMatchObject({ enabled: true, path: file });
    expect(by('fromclaude').source).toBeUndefined();
    expect(by('claudeoff').enabled).toBe(false);
    expect(by('sourceoff').enabled).toBe(true);
    expect(by('directoff').enabled).toBe(false);
    // 幂等：无迁移目标时不再落盘
    const after = fs.readFileSync(file, 'utf8');
    service.snapshot();
    expect(fs.readFileSync(file, 'utf8')).toBe(after);
  });

  it('toggles write per-entry enabled flags; materialized imports accept edit and remove', () => {
    const { agent, service } = setup();
    const file = path.join(agent, 'mcp.json');
    fs.writeFileSync(file, JSON.stringify({ imports: ['claude-code'], mcpServers: {} }));
    const rev = () => service.snapshot().mcpRevisions.user;
    service.mcpSave({ name: 'fromclaude', scope: 'user', enabled: false, revision: rev() });
    let raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(raw.mcpServers.fromclaude).toMatchObject({ enabled: false });
    expect(service.snapshot().mcp.find(r => r.name === 'fromclaude')!.enabled).toBe(false);
    service.mcpSave({ name: 'fromclaude', scope: 'user', enabled: true, revision: rev() });
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(raw.mcpServers.fromclaude).toMatchObject({ enabled: true });
    expect(service.snapshot().mcp.find(r => r.name === 'fromclaude')!.enabled).toBe(true);
    // 物化后即普通条目：可编辑、可移除
    service.mcpSave({ name: 'fromclaude', scope: 'user', remove: true, revision: rev() });
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers.fromclaude).toBeUndefined();
    // revision 过期照旧拒绝
    expect(() => service.mcpSave({ name: 'direct', scope: 'user', enabled: false, revision: 'missing' })).toThrow();
  });

  it('mcpTest reaches materialized import entries', async () => {
    const { agent, service } = setup();
    fs.writeFileSync(path.join(agent, 'mcp.json'), JSON.stringify({ imports: ['claude-code'], mcpServers: { direct: { command: node, args: [fakeMcp] } } }));
    const row = service.snapshot().mcp.find(r => r.name === 'fromclaude')!;
    const result = await service.mcpTest(row.id);
    expect(result.tools).toContain('echo');
  });
});

describe('mcp-bridge 版本门', () => {
  it('hasNativeMcp bounds mirror piHasNativeMcp semantics', async () => {
    const { hasNativeMcp } = await import('../extensions/desktop-policy/mcp-bridge.mjs');
    expect(hasNativeMcp('0.99.0')).toBe(true);
    expect(hasNativeMcp('0.99.1')).toBe(true);
    expect(hasNativeMcp('1.0.0')).toBe(true);
    expect(hasNativeMcp('0.98.9')).toBe(false);
    expect(hasNativeMcp('0.87.0')).toBe(false);
    expect(hasNativeMcp('')).toBe(false);
    expect(hasNativeMcp(undefined)).toBe(false);
    // 与主进程判定一致
    expect(hasNativeMcp('0.99.1')).toBe(piHasNativeMcp('0.99.1'));
    expect(hasNativeMcp('0.87.0')).toBe(piHasNativeMcp('0.87.0'));
  });

  async function loadBridge(agent: string, piVersion?: string) {
    const prevAgent = process.env.PI_CODING_AGENT_DIR, prevPerm = process.env.PI_DESKTOP_PERMISSION, prevTrust = process.env.PI_DESKTOP_TRUST_PROJECT, prevVer = process.env.PI_DESKTOP_PI_VERSION;
    process.env.PI_CODING_AGENT_DIR = agent;
    process.env.PI_DESKTOP_PERMISSION = 'full';
    process.env.PI_DESKTOP_TRUST_PROJECT = '0';
    if (piVersion === undefined) delete process.env.PI_DESKTOP_PI_VERSION; else process.env.PI_DESKTOP_PI_VERSION = piVersion;
    const tools: { label: string }[] = [];
    const handlers: Record<string, (e?: unknown, ctx?: unknown) => void> = {};
    const pi = { on: (ev: string, fn: (e?: unknown, ctx?: unknown) => void) => { handlers[ev] = fn; }, registerTool: (t: { label: string }) => tools.push(t) };
    const cleanup = () => {
      handlers['session_shutdown']?.();
      if (prevAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prevAgent;
      if (prevPerm === undefined) delete process.env.PI_DESKTOP_PERMISSION; else process.env.PI_DESKTOP_PERMISSION = prevPerm;
      if (prevTrust === undefined) delete process.env.PI_DESKTOP_TRUST_PROJECT; else process.env.PI_DESKTOP_TRUST_PROJECT = prevTrust;
      if (prevVer === undefined) delete process.env.PI_DESKTOP_PI_VERSION; else process.env.PI_DESKTOP_PI_VERSION = prevVer;
    };
    return { pi, tools, cleanup };
  }

  it('registers servers honoring per-entry enabled flags on legacy pi (<0.99)', async () => {
    const { agent } = setup();
    fs.writeFileSync(path.join(agent, 'mcp.json'), JSON.stringify({
      mcpServers: {
        direct: { command: node, args: [fakeMcp] },
        directoff: { command: node, args: [fakeMcp], enabled: false },
        fromclaude: { command: node, args: [fakeMcp] },
        claudeoff: { command: node, args: [fakeMcp], enabled: false },
      },
    }));
    const { pi, tools, cleanup } = await loadBridge(agent, '0.87.0');
    try {
      const { default: desktopMcp } = await import('../extensions/desktop-policy/mcp-bridge.mjs');
      await desktopMcp(pi as never);
      const deadline = Date.now() + 8000;
      while (tools.length < 2 && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
      const labels = tools.map(t => t.label);
      expect(labels.some(l => l.startsWith('direct /'))).toBe(true);
      expect(labels.some(l => l.startsWith('fromclaude /'))).toBe(true);
      expect(labels.some(l => l.startsWith('directoff') || l.startsWith('claudeoff'))).toBe(false);
    } finally { cleanup(); }
  });

  it('stands down entirely on pi ≥0.99 (native builtin:mcp owns connections)', async () => {
    const { agent } = setup();
    fs.writeFileSync(path.join(agent, 'mcp.json'), JSON.stringify({
      mcpServers: { direct: { command: node, args: [fakeMcp] } },
    }));
    const { pi, tools, cleanup } = await loadBridge(agent, '0.99.1');
    try {
      const { default: desktopMcp } = await import('../extensions/desktop-policy/mcp-bridge.mjs');
      await desktopMcp(pi as never);
      await new Promise(r => setTimeout(r, 600));
      expect(tools).toEqual([]);
    } finally { cleanup(); }
  });

  it('normalizeServerPaths resolves relative command/cwd against the source config directory', async () => {
    const { normalizeServerPaths } = await import('../extensions/desktop-policy/mcp-imports.cjs');
    const base = path.join(fakeHome, '.codex');
    // 相对 cwd + 相对 command 直接在 base 下命中
    const direct = normalizeServerPaths({ command: './plugins/MyTool.app/Contents/MacOS/toolbin', args: ['mcp'], cwd: '.' }, base);
    expect(direct.command).toBe(toolBin);
    expect(direct.cwd).toBe(base);
    // command 首段在 base 下浅搜唯一命中（真实案例：codex 相对路径基准不可复现），cwd 跟随发现目录
    const discovered = normalizeServerPaths({ command: './MyTool.app/Contents/MacOS/toolbin', cwd: '.' }, base);
    expect(discovered.command).toBe(toolBin);
    expect(discovered.cwd).toBe(path.join(base, 'plugins'));
    // 多义命中不猜测，原样返回交给连接层报错；绝对路径与 URL 服务不受影响
    fs.mkdirSync(path.join(base, 'mirror'), { recursive: true });
    fs.symlinkSync(path.join(base, 'plugins', 'MyTool.app'), path.join(base, 'mirror', 'MyTool.app'));
    const ambiguous = normalizeServerPaths({ command: './MyTool.app/Contents/MacOS/toolbin' }, base);
    expect(ambiguous.command).toBe('./MyTool.app/Contents/MacOS/toolbin');
    const absolute = normalizeServerPaths({ command: node }, base);
    expect(absolute.command).toBe(node);
    const url = normalizeServerPaths({ url: 'https://example.com/mcp' }, base);
    expect(url).toEqual({ url: 'https://example.com/mcp' });
  });
});
