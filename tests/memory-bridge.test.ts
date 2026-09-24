import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  detectMemoryPlugin,
  listMemoryFiles,
  readMemoryFileContent,
  formatMemoryTime,
  memoryAssistStatus,
  DEFAULT_MEMORY_SOURCE,
  KNOWN_MEMORY_PLUGINS,
} from '../src/main/pi/memory-bridge';

function tmpAgentDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pi-memory-bridge-'));
}

function writeSettings(agentDir: string, packages: unknown) {
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ packages }));
}

describe('detectMemoryPlugin', () => {
  it('detects registered pi-memory and reports its label', () => {
    const agentDir = tmpAgentDir();
    writeSettings(agentDir, ['npm:pi-memory']);
    const detected = detectMemoryPlugin(agentDir);
    expect(detected.kind).toBe('extension');
    if (detected.kind === 'extension') expect(detected.label).toBe('pi-memory');
  });

  it('detects known plugin with version suffix and npm: prefix', () => {
    const agentDir = tmpAgentDir();
    writeSettings(agentDir, [{ source: 'npm:@henryqw/pi-memory@7.0.2' }]);
    const detected = detectMemoryPlugin(agentDir);
    expect(detected.kind).toBe('extension');
  });

  it('falls back to builtin when no known memory plugin is registered', () => {
    const agentDir = tmpAgentDir();
    writeSettings(agentDir, ['npm:pi-subagents', 'npm:some-other-package']);
    expect(detectMemoryPlugin(agentDir).kind).toBe('builtin');
  });

  it('falls back to builtin when settings are missing', () => {
    expect(detectMemoryPlugin(tmpAgentDir()).kind).toBe('builtin');
  });

  it('registry covers the default source', () => {
    expect(DEFAULT_MEMORY_SOURCE).toBe('npm:pi-memory');
    expect(KNOWN_MEMORY_PLUGINS[0]!.name).toBe('pi-memory');
  });
});

describe('listMemoryFiles', () => {
  it('lists top-level and daily markdown files with entry counts, newest first', () => {
    const agentDir = tmpAgentDir();
    const memoryDir = path.join(agentDir, 'memory');
    fs.mkdirSync(path.join(memoryDir, 'daily'), { recursive: true });
    fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), '<!-- 2026-09-20 10:00:00 [a] -->\n#preference x\n<!-- 2026-09-21 11:00:00 [b] -->\n#lesson y\n');
    fs.writeFileSync(path.join(memoryDir, 'daily', '2026-09-24.md'), '<!-- 2026-09-24 09:00:00 [c] -->\n## Turn Summary\n');
    const files = listMemoryFiles(agentDir);
    expect(files.map(f => f.name)).toEqual(['2026-09-24.md', 'MEMORY.md']);
    expect(files[1]!.entries).toBe(2);
    expect(files[0]!.entries).toBe(1);
  });

  it('returns empty for missing memory dir', () => {
    expect(listMemoryFiles(tmpAgentDir())).toEqual([]);
  });
});

describe('readMemoryFileContent', () => {
  it('reads a memory file inside the dir', () => {
    const agentDir = tmpAgentDir();
    const memoryDir = path.join(agentDir, 'memory');
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), '# hello\n');
    expect(readMemoryFileContent(agentDir, 'MEMORY.md')).toBe('# hello\n');
  });

  it('rejects path escapes and non-markdown files', () => {
    const agentDir = tmpAgentDir();
    const memoryDir = path.join(agentDir, 'memory');
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'settings.json'), '{}');
    expect(() => readMemoryFileContent(agentDir, '../settings.json')).toThrow();
    expect(() => readMemoryFileContent(agentDir, 'notes.txt')).toThrow();
  });
});

describe('formatMemoryTime', () => {
  it('formats relative times like ZCode', () => {
    const now = new Date('2026-09-24T15:00:00').getTime();
    expect(formatMemoryTime(now - 30_000, now)).toBe('刚刚');
    expect(formatMemoryTime(new Date('2026-09-24T09:35:00').getTime(), now)).toBe('今天 09:35');
    expect(formatMemoryTime(new Date('2026-09-22T19:46:00').getTime(), now)).toMatch(/周二 19:46|19:46/);
    expect(formatMemoryTime(new Date('2026-09-01T08:00:00').getTime(), now)).toBe('9月1日');
  });
});

describe('memoryAssistStatus', () => {
  it('reports extension chain with hint', () => {
    const agentDir = tmpAgentDir();
    writeSettings(agentDir, ['npm:pi-memory']);
    const status = memoryAssistStatus(agentDir, true);
    expect(status.enabled).toBe(true);
    expect(status.plugin.kind).toBe('extension');
    expect(status.hint).toContain('记忆插件');
  });

  it('reports builtin fallback when nothing installed', () => {
    const status = memoryAssistStatus(tmpAgentDir(), false);
    expect(status.plugin.kind).toBe('builtin');
    expect(status.builtinDir).toContain(path.join('memory'));
  });
});
