import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearMemoryEnv, memoryAssistStatus, memorySessionEnv } from '../src/main/pi/memory-bridge';

// Temp dirs only; never touches the real ~/.pi config.
const dirs: string[] = [];
const temp = () => { const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memory-inject-'))); dirs.push(dir); return dir; };
const writeSettings = (agentDir: string, packages: unknown) => {
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ packages }));
};
afterEach(() => dirs.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));

describe('memorySessionEnv (backend launch env matrix)', () => {
  it('project session: injects pi-memory 0.4.2 project root with qmd update + search off', () => {
    const agentDir = temp(), project = temp();
    const env = memorySessionEnv({ enabled: true, dir: path.join(agentDir, 'memory') }, project, agentDir);
    expect(env.PI_MEMORY_DIR).toBe(path.join(project, '.pi', 'memory'));
    expect(env.PI_MEMORY_QMD_UPDATE).toBe('off');
    expect(env.PI_MEMORY_NO_SEARCH).toBe('1');
    // desktop-memory 自动摘要行为保持不变（项目写 <cwd>/.pi/memory/daily）。
    expect(env.PI_DESKTOP_MEMORY).toBe('1');
    expect(env.PI_DESKTOP_MEMORY_CWD).toBe(project);
    expect(env.PI_DESKTOP_MEMORY_DIR).toBe(path.join(agentDir, 'memory'));
  });

  it('no cwd / empty cwd: summary env only, PI_MEMORY_* stays unset (plugin global default)', () => {
    const agentDir = temp();
    for (const cwd of [undefined, '']) {
      const env = memorySessionEnv({ enabled: true, dir: path.join(agentDir, 'memory') }, cwd, agentDir);
      expect(env.PI_DESKTOP_MEMORY).toBe('1');
      expect(env.PI_DESKTOP_MEMORY_CWD).toBe('');
      expect(env.PI_DESKTOP_MEMORY_DIR).toBe(path.join(agentDir, 'memory'));
      expect(env.PI_MEMORY_DIR).toBeUndefined();
      expect(env.PI_MEMORY_QMD_UPDATE).toBeUndefined();
      expect(env.PI_MEMORY_NO_SEARCH).toBeUndefined();
    }
  });

  it('invalid cwd (relative / missing / file / NUL / vanished): falls back to global, no injection', () => {
    const agentDir = temp(), realFile = path.join(temp(), 'plain.txt');
    fs.writeFileSync(realFile, 'x');
    const vanishing = temp();
    for (const cwd of ['relative/path', path.join(agentDir, 'missing'), realFile, `bad\0cwd`]) {
      const env = memorySessionEnv({ enabled: true, dir: path.join(agentDir, 'memory') }, cwd, agentDir);
      expect(env.PI_MEMORY_DIR).toBeUndefined();
      expect(env.PI_MEMORY_QMD_UPDATE).toBeUndefined();
      expect(env.PI_MEMORY_NO_SEARCH).toBeUndefined();
      expect(env.PI_DESKTOP_MEMORY_CWD).toBe(cwd); // 摘要路径语义不变，失败即失败，不回退全局。
    }
    // 目录在校验瞬间消失（stat 抛错）同样不注入。
    fs.rmSync(vanishing, { recursive: true, force: true });
    const env = memorySessionEnv({ enabled: true, dir: path.join(agentDir, 'memory') }, vanishing, agentDir);
    expect(env.PI_MEMORY_DIR).toBeUndefined();
  });

  it('memory disabled: nothing injected at all, not even desktop summary vars', () => {
    const agentDir = temp(), project = temp();
    expect(memorySessionEnv({ enabled: false, dir: path.join(agentDir, 'memory') }, project, agentDir)).toEqual({});
  });

  it('clearMemoryEnv drops inherited/global scope vars before per-session assignment', () => {
    const agentDir = temp(), project = temp(), staleDir = temp();
    // Simulate backend.launch: env starts as a copy of process.env possibly carrying
    // a previous session's (or Desktop's own) memory scope.
    const env: NodeJS.ProcessEnv = { ...process.env, PI_MEMORY_DIR: staleDir, PI_MEMORY_QMD_UPDATE: 'background', PI_MEMORY_NO_SEARCH: '1', PI_DESKTOP_MEMORY: '1', PI_DESKTOP_MEMORY_CWD: staleDir };
    clearMemoryEnv(env);
    expect(env.PI_MEMORY_DIR).toBeUndefined();
    expect(env.PI_MEMORY_QMD_UPDATE).toBeUndefined();
    expect(env.PI_MEMORY_NO_SEARCH).toBeUndefined();
    expect(env.PI_DESKTOP_MEMORY).toBeUndefined();
    expect(env.PI_DESKTOP_MEMORY_CWD).toBeUndefined();
    Object.assign(env, memorySessionEnv({ enabled: true, dir: path.join(agentDir, 'memory') }, project, agentDir));
    // Project injection wins over the stale inherited scope.
    expect(env.PI_MEMORY_DIR).toBe(path.join(project, '.pi', 'memory'));
    // Global session (no cwd): stale inherited scope must not survive the clear.
    const globalEnv: NodeJS.ProcessEnv = { ...process.env, PI_MEMORY_DIR: staleDir };
    clearMemoryEnv(globalEnv);
    Object.assign(globalEnv, memorySessionEnv({ enabled: true, dir: path.join(agentDir, 'memory') }, undefined, agentDir));
    expect(globalEnv.PI_MEMORY_DIR).toBeUndefined();
  });
});

describe('memoryAssistStatus hint (project injection scope + search off)', () => {
  it('extension registered: hint explains project root injection, qmd/search off, global fallback', () => {
    const agentDir = temp();
    writeSettings(agentDir, ['npm:pi-memory']);
    const status = memoryAssistStatus(agentDir, true);
    expect(status.plugin.kind).toBe('extension');
    expect(status.hint).toContain('记忆插件');
    expect(status.hint).toContain('.pi/memory');
    expect(status.hint).toContain('检索');
    expect(status.hint).toContain('关闭');
    expect(status.hint).toContain('全局');
  });

  it('builtin fallback: hint mentions no plugin detected, harmless env vars, and what happens after install', () => {
    const status = memoryAssistStatus(temp(), false);
    expect(status.plugin.kind).toBe('builtin');
    expect(status.hint).toContain('未检测到记忆插件');
    expect(status.hint).toContain('无副作用');
    expect(status.hint).toContain('.pi/memory');
  });
});
