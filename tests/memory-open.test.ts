import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openMemoryFile, resolveMemoryOpen } from '../src/main/pi/memory-open';
import { projectMemoryFile } from '../src/main/pi/memory-bridge';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(p => fs.rmSync(p, { recursive: true, force: true })));
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-open-')); roots.push(root);
  const agent = path.join(root, 'agent'), project = path.join(root, 'project');
  fs.mkdirSync(path.join(agent, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(project, '.pi/memory'), { recursive: true });
  fs.writeFileSync(path.join(agent, 'memory/global.md'), 'synthetic');
  fs.writeFileSync(path.join(project, '.pi/memory/local.md'), 'synthetic');
  return { root, agent, project, known: [project] };
}
describe('memory file opening boundary', () => {
  it('wires a dedicated IPC without changing the project openWith directory boundary', () => {
    const main = fs.readFileSync('src/main/index.ts', 'utf8');
    const preload = fs.readFileSync('src/preload/index.ts', 'utf8');
    expect(main).toContain("handle('memoryOpen', (rel, cwd, appId) => openMemoryFile");
    expect(preload).toContain("memoryOpen: (rel, cwd, appId) => invoke('memoryOpen', rel, cwd, appId)");
    expect(main).toContain('const real = authorizeProjectCwd(cwd, known)');
    expect(main).toContain('return openWithApp(real, appId,');
  });
  it('reveals a file, opens an editor with argv, and rejects terminals/unknown/uninstalled apps', async () => {
    const { agent, project, known } = fixture();
    const reveal = vi.fn(), run = vi.fn(async () => {});
    const deps = { platform: 'darwin', existsSync: (p: string) => p === '/Applications/Visual Studio Code.app', reveal, run };
    await openMemoryFile(agent, 'global.md', undefined, 'finder', known, deps);
    expect(reveal).toHaveBeenCalledWith(fs.realpathSync(path.join(agent, 'memory/global.md')));
    await openMemoryFile(agent, 'projects-external/local.md', project, 'vscode', known, deps);
    expect(run).toHaveBeenCalledWith('/usr/bin/open', ['-a', '/Applications/Visual Studio Code.app', fs.realpathSync(path.join(project, '.pi/memory/local.md'))]);
    for (const app of ['terminal', 'webstorm', '/bin/sh', '--args', null]) await expect(openMemoryFile(agent, 'global.md', project, app, known, deps)).rejects.toThrow('打开方式不可用');
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('rejects forged cwd, traversal, absolute paths, other project mappings and non-files', () => {
    const { agent, project, known } = fixture();
    for (const rel of ['../global.md', '/tmp/secret.md', 'a/../global.md', 'a\\b.md', 'global.md\0', 'global.txt', 'projects/other.md']) expect(() => resolveMemoryOpen(agent, rel, project, known)).toThrow();
    expect(() => resolveMemoryOpen(agent, 'global.md', '/unknown', known)).toThrow();
    expect(() => resolveMemoryOpen(agent, 'projects-external/local.md', undefined, known)).toThrow();
    fs.mkdirSync(path.join(agent, 'memory/dir.md'));
    expect(() => resolveMemoryOpen(agent, 'dir.md', undefined, known)).toThrow();
    fs.symlinkSync(path.join(agent, 'memory/global.md'), path.join(agent, 'memory/alias.md'));
    expect(() => resolveMemoryOpen(agent, 'alias.md', undefined, known)).toThrow('符号链接');
    const legacy = projectMemoryFile(agent, fs.realpathSync(project));
    fs.mkdirSync(path.dirname(legacy)); fs.writeFileSync(legacy, 'synthetic');
    expect(resolveMemoryOpen(agent, `projects/${path.basename(legacy)}`, project, known)).toBe(fs.realpathSync(legacy));
  });
  it('blocks symlink escapes including a symlinked memory root and .pi ancestor', () => {
    const { root, agent, project, known } = fixture();
    fs.writeFileSync(path.join(root, 'outside.md'), 'synthetic');
    fs.symlinkSync(path.join(root, 'outside.md'), path.join(agent, 'memory/link.md'));
    expect(() => resolveMemoryOpen(agent, 'link.md', undefined, known)).toThrow();
    fs.rmSync(path.join(project, '.pi'), { recursive: true });
    fs.symlinkSync(agent, path.join(project, '.pi'));
    expect(() => resolveMemoryOpen(agent, 'projects-external/global.md', project, known)).toThrow();
    fs.renameSync(path.join(agent, 'memory'), path.join(root, 'outside'));
    fs.symlinkSync(path.join(root, 'outside'), path.join(agent, 'memory'));
    expect(() => resolveMemoryOpen(agent, 'global.md', undefined, known)).toThrow();
  });
  it('supports files larger than preview limit and non-macOS reveal', async () => {
    const { agent, known } = fixture();
    fs.writeFileSync(path.join(agent, 'memory/global.md'), Buffer.alloc(600 * 1024));
    const reveal = vi.fn();
    await openMemoryFile(agent, 'global.md', undefined, 'file-manager', known, { platform: 'linux', reveal });
    expect(reveal).toHaveBeenCalledOnce();
  });
});
