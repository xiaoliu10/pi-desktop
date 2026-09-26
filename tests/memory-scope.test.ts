import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listMemoryFiles, projectMemoryFile, readMemoryFileContent } from '../src/main/pi/memory-bridge';

const dirs: string[] = [];
const temp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-scope-')); dirs.push(dir); return dir; };
const write = (file: string, text = '# fixture') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
afterEach(() => dirs.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));

describe('memory browsing scopes (synthetic files only)', () => {
  it('global excludes projects; project includes shared global and only its own files', () => {
    const agent = temp(), a = temp(), b = temp();
    write(path.join(agent, 'memory', 'MEMORY.md'));
    write(path.join(agent, 'memory', 'daily', 'today.md'));
    write(projectMemoryFile(agent, a)); write(projectMemoryFile(agent, '/unrelated-project'));
    expect(projectMemoryFile(agent, a)).not.toBe(projectMemoryFile(agent, '/unrelated-project'));
    write(path.join(a, '.pi', 'memory', 'local.md'), 'A');
    write(path.join(b, '.pi', 'memory', 'local.md'), 'B');
    expect(listMemoryFiles(agent).map(f => f.rel).sort()).toEqual(['MEMORY.md', 'daily/today.md']);
    const files = listMemoryFiles(agent, a);
    expect(files.filter(f => f.scope === 'global')).toHaveLength(2);
    expect(files.filter(f => f.scope === 'project').map(f => f.path).sort()).toEqual([projectMemoryFile(agent, a), path.join(a, '.pi', 'memory', 'local.md')].sort());
    expect(readMemoryFileContent(agent, 'projects-external/local.md', a)).toBe('A');
    expect(readMemoryFileContent(agent, 'projects-external/local.md', b)).toBe('B');
    expect(() => readMemoryFileContent(agent, 'projects-external/local.md')).toThrow('选择项目');
  });
  it('matches distinct short project paths without returning another project file', () => {
    const agent = temp();
    write(projectMemoryFile(agent, '/fixture/alpha'), 'alpha');
    write(projectMemoryFile(agent, '/fixture/beta'), 'beta');
    const files = listMemoryFiles(agent, '/fixture/alpha');
    expect(files).toHaveLength(1);
    expect(readMemoryFileContent(agent, files[0]!.rel)).toBe('alpha');
  });
  it('keeps the legacy truncated mapping unchanged (not a strict isolation boundary)', () => {
    const agent = temp();
    const prefix = '/fixture/' + 'long-path-'.repeat(6);
    expect(projectMemoryFile(agent, prefix + '/alpha')).toBe(projectMemoryFile(agent, prefix + '/beta'));
  });
  it('rejects traversal and symlink previews and skips linked files/loops in lists', () => {
    const agent = temp(), project = temp(), outside = temp();
    write(path.join(agent, 'memory', 'safe.md'));
    write(path.join(project, '.pi', 'memory', 'safe.md'));
    write(path.join(outside, 'secret.md'), 'not memory');
    fs.symlinkSync(path.join(outside, 'secret.md'), path.join(agent, 'memory', 'link.md'));
    fs.symlinkSync(path.join(agent, 'memory'), path.join(agent, 'memory', 'loop'));
    fs.symlinkSync(path.join(outside, 'secret.md'), path.join(project, '.pi', 'memory', 'link.md'));
    expect(listMemoryFiles(agent, project).map(f => f.name)).toEqual(['safe.md', 'safe.md']);
    expect(() => readMemoryFileContent(agent, 'link.md')).toThrow('路径无效');
    expect(() => readMemoryFileContent(agent, 'projects-external/link.md', project)).toThrow('路径无效');
    expect(() => readMemoryFileContent(agent, 'projects-external/../../../secret.md', project)).toThrow('路径无效');
  });
});
