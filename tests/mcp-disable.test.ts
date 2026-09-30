// MCP 启停全覆盖：导入服务（claude-code 等）在 Desktop 的禁用只能写自己 mcp.json 的
// disabledServers 覆盖层（不改原工具文件）；直连服务沿用配置内 disabled 字段。
// 覆盖：settings-service 快照/启停往返 + mcp-bridge 运行时跳过被禁服务。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PiHost } from '../src/main/pi/host';
import { SettingsService } from '../src/main/pi/settings-service';

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

it('imported servers list with overlay-disabled state and stay editable only in Desktop', () => {
  const { agent, service } = setup();
  fs.writeFileSync(path.join(agent, 'mcp.json'), JSON.stringify({
    imports: ['claude-code'],
    mcpServers: { direct: { command: node, args: [fakeMcp] }, directoff: { command: node, args: [fakeMcp] } },
    disabledServers: ['claudeoff', 'directoff'],
  }));
  const rows = service.snapshot().mcp;
  const by = (name: string) => rows.find(r => r.name === name)!;
  expect(by('fromclaude')).toMatchObject({ source: 'claude-code', enabled: true, scope: 'user' });
  expect(by('claudeoff')).toMatchObject({ source: 'claude-code', enabled: false });
  expect(by('selfoff')).toMatchObject({ source: 'claude-code', enabled: false });
  expect(by('direct')).toMatchObject({ enabled: true, scope: 'user' });
  expect(by('directoff')).toMatchObject({ enabled: false });
});

it('toggling an imported server rewrites only the Desktop disabledServers overlay', () => {
  const { agent, service } = setup();
  const file = path.join(agent, 'mcp.json');
  fs.writeFileSync(file, JSON.stringify({ imports: ['claude-code'], mcpServers: {}, disabledServers: [] }));
  const rev = () => service.snapshot().mcpRevisions.user;
  // 禁用：加入覆盖层
  service.mcpSave({ name: 'fromclaude', scope: 'user', enabled: false, source: 'claude-code', revision: rev() });
  let raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  expect(raw.disabledServers).toEqual(['fromclaude']);
  expect(raw.mcpServers).toEqual({});
  expect(service.snapshot().mcp.find(r => r.name === 'fromclaude')!.enabled).toBe(false);
  // 重复禁用不产生重复项；再启用则移除，列表清空后键整体删除
  service.mcpSave({ name: 'fromclaude', scope: 'user', enabled: false, source: 'claude-code', revision: rev() });
  service.mcpSave({ name: 'fromclaude', scope: 'user', enabled: true, source: 'claude-code', revision: rev() });
  raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  expect(raw.disabledServers).toBeUndefined();
  expect(service.snapshot().mcp.find(r => r.name === 'fromclaude')!.enabled).toBe(true);
  // 导入服务不接受编辑/移除路径；revision 过期照旧拒绝
  expect(() => service.mcpSave({ name: 'fromclaude', scope: 'user', enabled: false, source: 'claude-code', revision: rev(), config: '{"command":"x"}' })).toThrow('仅支持启停');
  expect(() => service.mcpSave({ name: 'fromclaude', scope: 'user', enabled: false, source: 'claude-code', revision: 'missing' })).toThrow('配置已变化');
});

it('direct servers keep in-place disabled flag; mcpTest still reaches a disabled import', async () => {
  const { agent, service } = setup();
  fs.writeFileSync(path.join(agent, 'mcp.json'), JSON.stringify({ imports: ['claude-code'], mcpServers: { direct: { command: node, args: [fakeMcp] } } }));
  const row = service.snapshot().mcp.find(r => r.name === 'direct')!;
  service.mcpSave({ name: 'direct', scope: 'user', enabled: false, revision: row.revision });
  expect(JSON.parse(fs.readFileSync(path.join(agent, 'mcp.json'), 'utf8')).mcpServers.direct).toMatchObject({ disabled: true });
  // 检测连接不受停用影响（显式运行命令诊断连通性）
  const result = await service.mcpTest(service.snapshot().mcp.find(r => r.name === 'fromclaude')!.id);
  expect(result.tools).toContain('echo');
});

it('mcp-bridge skips overlay-disabled servers and registers the rest', async () => {
  const { agent, service } = setup();
  void service;
  fs.writeFileSync(path.join(agent, 'mcp.json'), JSON.stringify({
    imports: ['claude-code'],
    mcpServers: { direct: { command: node, args: [fakeMcp] }, directoff: { command: node, args: [fakeMcp] } },
    disabledServers: ['claudeoff', 'directoff'],
  }));
  const prevAgent = process.env.PI_CODING_AGENT_DIR, prevPerm = process.env.PI_DESKTOP_PERMISSION, prevTrust = process.env.PI_DESKTOP_TRUST_PROJECT;
  process.env.PI_CODING_AGENT_DIR = agent;
  process.env.PI_DESKTOP_PERMISSION = 'full';
  process.env.PI_DESKTOP_TRUST_PROJECT = '0';
  const tools: { label: string }[] = [];
  const handlers: Record<string, (e?: unknown, ctx?: unknown) => void> = {};
  const pi = { on: (ev: string, fn: (e?: unknown, ctx?: unknown) => void) => { handlers[ev] = fn; }, registerTool: (t: { label: string }) => tools.push(t) };
  try {
    const { default: desktopMcp } = await import('../extensions/desktop-policy/mcp-bridge.mjs');
    await desktopMcp(pi as never);
    const deadline = Date.now() + 8000;
    while (tools.length < 2 && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
    const labels = tools.map(t => t.label);
    expect(labels.some(l => l.startsWith('direct /'))).toBe(true);
    expect(labels.some(l => l.startsWith('fromclaude'))).toBe(true);
    expect(labels.some(l => l.startsWith('claudeoff') || l.startsWith('directoff'))).toBe(false);
  } finally {
    handlers['session_shutdown']?.();
    if (prevAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prevAgent;
    if (prevPerm === undefined) delete process.env.PI_DESKTOP_PERMISSION; else process.env.PI_DESKTOP_PERMISSION = prevPerm;
    if (prevTrust === undefined) delete process.env.PI_DESKTOP_TRUST_PROJECT; else process.env.PI_DESKTOP_TRUST_PROJECT = prevTrust;
  }
});

describe('来源工具 enabled=false 的导入服务与相对路径归一化', () => {
  it('enabledServers 显式启用覆盖来源工具的 enabled=false；禁用互斥维护', () => {
    const { agent, service } = setup();
    const file = path.join(agent, 'mcp.json');
    fs.writeFileSync(file, JSON.stringify({ imports: ['claude-code'], mcpServers: {} }));
    // 来源 enabled=false：快照禁用
    expect(service.snapshot().mcp.find(r => r.name === 'sourceoff')!.enabled).toBe(false);
    // 启用：写入 enabledServers 覆盖层，快照变启用，原工具文件不动
    const rev = () => service.snapshot().mcpRevisions.user;
    service.mcpSave({ name: 'sourceoff', scope: 'user', enabled: true, source: 'claude-code', revision: rev() });
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(raw.enabledServers).toEqual(['sourceoff']);
    expect(raw.disabledServers).toBeUndefined();
    expect(service.snapshot().mcp.find(r => r.name === 'sourceoff')!.enabled).toBe(true);
    // 再禁用：enabledServers 移除、disabledServers 接管（不会两边同时出现）
    service.mcpSave({ name: 'sourceoff', scope: 'user', enabled: false, source: 'claude-code', revision: rev() });
    const raw2 = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(raw2.enabledServers).toBeUndefined();
    expect(raw2.disabledServers).toEqual(['sourceoff']);
    expect(service.snapshot().mcp.find(r => r.name === 'sourceoff')!.enabled).toBe(false);
  });

  it('mcp-bridge registers a source-disabled import forced on by enabledServers', async () => {
    const { agent } = setup();
    fs.writeFileSync(path.join(agent, 'mcp.json'), JSON.stringify({
      imports: ['claude-code'],
      mcpServers: {},
      enabledServers: ['sourceoff'],
      disabledServers: ['claudeoff'],
    }));
    const prevAgent = process.env.PI_CODING_AGENT_DIR, prevPerm = process.env.PI_DESKTOP_PERMISSION, prevTrust = process.env.PI_DESKTOP_TRUST_PROJECT;
    process.env.PI_CODING_AGENT_DIR = agent;
    process.env.PI_DESKTOP_PERMISSION = 'full';
    process.env.PI_DESKTOP_TRUST_PROJECT = '0';
    const tools: { label: string }[] = [];
    const handlers: Record<string, (e?: unknown, ctx?: unknown) => void> = {};
    const pi = { on: (ev: string, fn: (e?: unknown, ctx?: unknown) => void) => { handlers[ev] = fn; }, registerTool: (t: { label: string }) => tools.push(t) };
    try {
      const { default: desktopMcp } = await import('../extensions/desktop-policy/mcp-bridge.mjs');
      await desktopMcp(pi as never);
      const deadline = Date.now() + 8000;
      while (tools.length < 1 && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
      expect(tools.some(t => t.label.startsWith('sourceoff'))).toBe(true);
      expect(tools.some(t => t.label.startsWith('claudeoff'))).toBe(false);
    } finally {
      handlers['session_shutdown']?.();
      if (prevAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prevAgent;
      if (prevPerm === undefined) delete process.env.PI_DESKTOP_PERMISSION; else process.env.PI_DESKTOP_PERMISSION = prevPerm;
      if (prevTrust === undefined) delete process.env.PI_DESKTOP_TRUST_PROJECT; else process.env.PI_DESKTOP_TRUST_PROJECT = prevTrust;
    }
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
