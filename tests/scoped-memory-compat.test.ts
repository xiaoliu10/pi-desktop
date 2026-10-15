import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import desktopMemory, { appendMemorySummary } from '../extensions/desktop-memory/index.mjs';
import { clearMemoryEnv, detectMemoryPlugin, listMemoryFiles, memoryAssistStatus, memorySessionEnv, readMemoryFileContent, scopedProjectMemoryDir } from '../src/main/pi/memory-bridge';

const dirs: string[] = [];
const temp = () => { const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scoped-compat-'))); dirs.push(dir); return dir; };
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); dirs.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })); });
const setup = (spec: unknown = 'npm:@wengine-ai/pi-scoped-memory') => {
  const agent = temp(), project = temp();
  fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ packages: [spec] }));
  return { agent, project };
};

describe('Scoped Memory compatibility', () => {
  it.each(['npm:@wengine-ai/pi-scoped-memory', { source: 'npm:@wengine-ai/pi-scoped-memory@0.1.0' }, 'npm:pi-scoped-memory'])('recognizes %j without legacy env overrides', spec => {
    const { agent, project } = setup(spec);
    expect(detectMemoryPlugin(agent)).toMatchObject({ kind: 'extension', label: 'Scoped Memory' });
    const env = memorySessionEnv({ enabled: true, dir: path.join(agent, 'memory') }, project, agent);
    expect(env.PI_MEMORY_DIR).toBeUndefined();
    expect(env.PI_MEMORY_QMD_UPDATE).toBeUndefined();
    expect(env.PI_MEMORY_NO_SEARCH).toBeUndefined();
    expect(env.PI_DESKTOP_MEMORY_SCOPED).toBe('1');
    expect(env.PI_DESKTOP_MEMORY_DIR).toBe(scopedProjectMemoryDir(agent, project));
    expect(memoryAssistStatus(agent, true).hint).toContain('memory-projects');
  });
  it.skipIf(process.platform === 'win32')('matches the deployed plugin project key', () => {
    expect(path.basename(scopedProjectMemoryDir('/agent', '/Users/jason/projects/opensource/pi-desktop'))).toBe('pi-desktop-56534009d11f80e2');
  });
  it('writes, lists and reads centralized project summaries without recreating .pi', () => {
    const { agent, project } = setup();
    const dir = scopedProjectMemoryDir(agent, project);
    const file = appendMemorySummary(dir, project, 'centralized summary', new Date('2026-10-15T00:00:00Z'), true);
    expect(file).toBe(path.join(dir, 'daily', '2026-10-15.md'));
    expect(fs.existsSync(path.join(project, '.pi'))).toBe(false);
    const files = listMemoryFiles(agent, project);
    expect(files).toHaveLength(1);
    expect(readMemoryFileContent(agent, files[0].rel, project)).toContain('centralized summary');
    expect(listMemoryFiles(agent, temp())).toEqual([]);
  });
  it('uses centralized env through the real recap lifecycle', async () => {
    vi.useFakeTimers();
    const { agent, project } = setup();
    const env = memorySessionEnv({ enabled: true, dir: '' }, project, agent);
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const handlers: Record<string, Function> = {};
    desktopMemory({ on: (event: string, fn: Function) => { handlers[event] = fn; } });
    handlers.agent_end({}, {
      isIdle: () => true, hasPendingMessages: () => false, model: { id: 'fixture' },
      sessionManager: { getBranch: () => [1, 2, 3, 4].map(n => ({ type: 'message', message: { role: n % 2 ? 'user' : 'assistant', content: String(n) } })) },
      modelRegistry: { streamSimple: () => ({ result: async () => ({ stopReason: 'stop', content: [{ type: 'text', text: 'lifecycle recap' }] }) }) },
    });
    await vi.advanceTimersByTimeAsync(20000);
    const files = listMemoryFiles(agent, project);
    expect(files).toHaveLength(1);
    expect(readMemoryFileContent(agent, files[0].rel, project)).toContain('lifecycle recap');
    expect(fs.existsSync(path.join(project, '.pi'))).toBe(false);
    handlers.session_shutdown();
  });
  it('fails closed for missing project and rejects linked centralized roots', () => {
    const { agent, project } = setup();
    const dir = scopedProjectMemoryDir(agent, project);
    expect(() => appendMemorySummary(dir, path.join(project, 'missing'), 'no fallback', new Date(), true)).toThrow();
    const other = temp();
    fs.symlinkSync(other, path.join(agent, 'memory-projects'));
    expect(() => appendMemorySummary(dir, project, 'no escape', new Date(), true)).toThrow();
    expect(fs.readdirSync(other)).toEqual([]);
    expect(fs.readdirSync(project)).toEqual([]);
  });
  it('preserves global summaries and clears stale scoped flag between launches', () => {
    const { agent } = setup();
    const env = memorySessionEnv({ enabled: true, dir: 'ignored' }, undefined, agent);
    expect(env.PI_DESKTOP_MEMORY_DIR).toBe(path.join(agent, 'memory'));
    const inherited: NodeJS.ProcessEnv = { ...env }; clearMemoryEnv(inherited);
    expect(inherited.PI_DESKTOP_MEMORY_SCOPED).toBeUndefined();
    expect(memorySessionEnv({ enabled: false, dir: '' }, undefined, agent)).toEqual({});
  });
});
