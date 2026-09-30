import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listMemoryFiles, migrateLegacyMemoryFile, moveMemoryFileToProject, projectMemoryFile, readMemoryFileContent } from '../src/main/pi/memory-bridge';

const dirs: string[] = [];
const temp = () => { const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memory-scope-'))); dirs.push(dir); return dir; };
const write = (file: string, text = '# fixture') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
afterEach(() => dirs.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));

describe('memory browsing scopes (synthetic files only)', () => {
  it('global excludes projects; project view only shows its own files (no shared/global files)', () => {
    const agent = temp(), a = temp(), b = temp();
    write(path.join(agent, 'memory', 'MEMORY.md'));
    write(path.join(agent, 'memory', 'daily', 'today.md'));
    write(projectMemoryFile(agent, a)); write(projectMemoryFile(agent, '/unrelated-project'));
    expect(projectMemoryFile(agent, a)).not.toBe(projectMemoryFile(agent, '/unrelated-project'));
    write(path.join(a, '.pi', 'memory', 'local.md'), 'A');
    write(path.join(b, '.pi', 'memory', 'local.md'), 'B');
    // 全局视图：共享文件 + 旧版 projects/ 映射（带归属标注），但绝不混入项目本地 .pi/memory 文件
    const global = listMemoryFiles(agent);
    expect(global.filter(f => f.path.includes('.pi/memory') && !f.path.includes(`${agent}/memory`))).toHaveLength(0);
    expect(global.map(f => f.rel).sort()).toEqual(['MEMORY.md', 'daily/today.md', `projects/${path.basename(projectMemoryFile(agent, a))}`, `projects/${path.basename(projectMemoryFile(agent, '/unrelated-project'))}`].sort());
    expect(global.find(f => f.rel.startsWith('projects/'))!.project).toBeDefined();
    const files = listMemoryFiles(agent, a);
    // 选中项目：不混入全局目录文件（含 daily/），也不返回其他项目的专属记忆
    expect(files.filter(f => f.scope === 'global')).toHaveLength(0);
    expect(files.some(f => f.rel.startsWith('projects/') && f.rel !== `projects/${path.basename(projectMemoryFile(agent, a))}`)).toBe(false);
    expect(files.map(f => f.path).sort()).toEqual([projectMemoryFile(agent, a), path.join(a, '.pi', 'memory', 'local.md')].sort());
    expect(readMemoryFileContent(agent, 'projects-external/local.md', a)).toBe('A');
    expect(readMemoryFileContent(agent, 'projects-external/local.md', b)).toBe('B');
    expect(() => readMemoryFileContent(agent, 'projects-external/local.md')).toThrow('选择项目');
  });
  it('global view can read attributed legacy files; project scope still cannot read others’ legacy files', () => {
    const agent = temp(), project = temp();
    write(projectMemoryFile(agent, project), 'legacy');
    write(projectMemoryFile(agent, '/unrelated-project'), 'other');
    write(path.join(agent, 'memory', 'global.md'), 'shared');
    const files = listMemoryFiles(agent, project);
    expect(files).toHaveLength(1);
    expect(readMemoryFileContent(agent, files[0]!.rel, project)).toBe('legacy');
    // 全局视图可读旧版映射（归属已在列表标注）；项目视图仍不能碰其他项目的旧文件
    expect(readMemoryFileContent(agent, `projects/${path.basename(projectMemoryFile(agent, '/unrelated-project'))}`)).toBe('other');
    for (const rel of ['global.md', `projects/${path.basename(projectMemoryFile(agent, '/unrelated-project'))}`, 'projects-external/../../memory/global.md', '/tmp/secret.md', 'projects-external/a/../local.md', 'projects-external/a\\\\b.md']) {
      expect(() => readMemoryFileContent(agent, rel, project)).toThrow();
    }
  });
  it('keeps the legacy truncated mapping unchanged (not a strict isolation boundary)', () => {
    const agent = temp();
    const prefix = '/fixture/' + 'long-path-'.repeat(6);
    expect(projectMemoryFile(agent, prefix + '/alpha')).toBe(projectMemoryFile(agent, prefix + '/beta'));
  });
  it.each(['.pi', '.pi/memory', '.pi/memory/daily'])('blocks ancestor symlink escape at %s for recursive list/read/open', async link => {
    const { resolveMemoryOpen } = await import('../src/main/pi/memory-open');
    const agent = temp(), project = temp(), other = temp();
    write(path.join(agent, 'memory', 'global.md'), 'shared');
    // The same relative filename in each possible symlink target.
    for (const rel of ['memory/daily/note.md', 'daily/note.md', 'note.md']) write(path.join(other, rel), 'other project');
    const alias = path.join(project, link);
    fs.mkdirSync(path.dirname(alias), { recursive: true }); fs.symlinkSync(other, alias);
    expect(listMemoryFiles(agent, project)).toEqual([]);
    expect(() => readMemoryFileContent(agent, 'projects-external/daily/note.md', project)).toThrow();
    expect(() => resolveMemoryOpen(agent, 'projects-external/daily/note.md', project, [project])).toThrow();
  });
  it('does not fall back to global when project is missing or malformed', () => {
    const agent = temp(); write(path.join(agent, 'memory', 'global.md'), 'shared');
    for (const project of [path.join(agent, 'missing'), 'relative', null]) {
      expect(() => listMemoryFiles(agent, project as any)).toThrow();
      expect(() => readMemoryFileContent(agent, 'global.md', project as any)).toThrow();
    }
  });
  it('rejects traversal and symlink previews and skips linked files/loops in lists', () => {
    const agent = temp(), project = temp(), outside = temp();
    write(path.join(agent, 'memory', 'safe.md'));
    write(path.join(project, '.pi', 'memory', 'safe.md'));
    write(path.join(outside, 'secret.md'), 'not memory');
    fs.symlinkSync(path.join(outside, 'secret.md'), path.join(agent, 'memory', 'link.md'));
    fs.symlinkSync(path.join(agent, 'memory'), path.join(agent, 'memory', 'loop'));
    fs.symlinkSync(path.join(outside, 'secret.md'), path.join(project, '.pi', 'memory', 'link.md'));
    // 项目视图只含项目自己的文件（全局 safe.md 不混入；symlink 均被跳过）
    expect(listMemoryFiles(agent, project).map(f => f.name)).toEqual(['safe.md']);
    expect(() => readMemoryFileContent(agent, 'link.md')).toThrow('路径无效');
    expect(() => readMemoryFileContent(agent, 'projects-external/link.md', project)).toThrow('路径无效');
    expect(() => readMemoryFileContent(agent, 'projects-external/../../../secret.md', project)).toThrow('路径无效');
  });
});

describe('legacy projects/ attribution (user question: which project does a historical file belong to)', () => {
  it('labels legacy files with the owning project via forward slug, decode, prefix or none', () => {
    const agent = temp();
    const shortProject = path.join(agent, 'proj-short');
    const longProject = `/Users/jason/projects/${'x'.repeat(30)}/very-long-project-name-that-overflows-slug`;
    const known = [{ path: shortProject, name: '短名项目' }, { path: longProject, name: '长路径项目' }];
    const slugOf = (p: string) => Buffer.from(path.resolve(p)).toString('base64url').slice(0, 48);
    // 已登记项目：正向精确命中（长路径 slug 截断仍命中）
    write(path.join(agent, 'memory', 'projects', `${slugOf(shortProject)}.md`));
    write(path.join(agent, 'memory', 'projects', `${slugOf(longProject)}.md`));
    // 未登记短路径：反解码得完整路径
    const mystery = '/tmp/mystery-legacy-project';
    write(path.join(agent, 'memory', 'projects', `${slugOf(mystery)}.md`));
    // 完全无法识别：随机 slug（保证不以 / 解码）
    const undecodable = Buffer.from('not-a-path-at-all').toString('base64url');
    write(path.join(agent, 'memory', 'projects', `${undecodable}.md`));
    const byRel = Object.fromEntries(listMemoryFiles(agent, undefined, known).map(f => [f.rel, f.project]));
    expect(byRel[`projects/${slugOf(shortProject)}.md`]).toBe('短名项目');
    expect(byRel[`projects/${slugOf(longProject)}.md`]).toBe('长路径项目');
    expect(byRel[`projects/${slugOf(mystery)}.md`]).toBe(mystery);
    expect(byRel[`projects/${undecodable}.md`]).toBeUndefined();
  });
  it('flags shared slugs when multiple known projects map to the same legacy file', () => {
    const agent = temp();
    // 构造 slug 碰撞：第二个路径在首路径第 36 字节处仅多内容（base64 前 48 字符相同）
    const base = '/Users/jason/projects/demo-with-a-very-long-nam';
    const p1 = base + 'e/alpha', p2 = base + 'z/beta';
    expect(Buffer.from(p1).toString('base64url').slice(0, 48)).toBe(Buffer.from(p2).toString('base64url').slice(0, 48));
    const known = [{ path: p1, name: 'Alpha' }, { path: p2, name: 'Beta' }];
    const slug = Buffer.from(p1).toString('base64url').slice(0, 48);
    write(path.join(agent, 'memory', 'projects', `${slug}.md`));
    const file = listMemoryFiles(agent, undefined, known).find(f => f.rel.startsWith('projects/'))!;
    expect(file.project).toBe('Alpha、Beta（共用）');
  });
});

describe('legacy migration into the owning project (user request: project memories should not live in global)', () => {
  it('moves an attributed legacy file into <project>/.pi/memory/legacy and refuses ambiguous ones', () => {
    const agent = temp(), project = temp();
    const known = [{ path: project, name: 'MyProject' }];
    const slugOf = (p: string) => Buffer.from(path.resolve(p)).toString('base64url').slice(0, 48);
    const rel = `projects/${slugOf(project)}.md`;
    write(path.join(agent, 'memory', 'projects', `${slugOf(project)}.md`), 'legacy body');
    const result = migrateLegacyMemoryFile(agent, rel, known);
    const dest = path.join(project, '.pi', 'memory', 'legacy', `${slugOf(project)}.md`);
    expect(result.movedTo).toBe(fs.realpathSync(dest));
    expect(fs.readFileSync(dest, 'utf8')).toBe('legacy body');
    expect(fs.existsSync(path.join(agent, 'memory', 'projects', `${slugOf(project)}.md`))).toBe(false); // 原文件已移走（空目录允许保留）
    // 迁移后项目视图自然收录（项目本地浏览是递归的），全局视图不再出现
    expect(listMemoryFiles(agent, project).some(f => f.path === dest)).toBe(true);
    expect(listMemoryFiles(agent, undefined, known).some(f => f.rel.startsWith('projects/'))).toBe(false);
    // 共用 slug（碰撞）→ 拒绝；未识别 → 拒绝；项目目录缺失 → 拒绝
    const base = '/Users/jason/projects/demo-with-a-very-long-nam';
    const p1 = base + 'e/alpha', p2 = base + 'z/beta';
    const sharedSlug = Buffer.from(p1).toString('base64url').slice(0, 48);
    write(path.join(agent, 'memory', 'projects', `${sharedSlug}.md`));
    expect(() => migrateLegacyMemoryFile(agent, `projects/${sharedSlug}.md`, [{ path: p1, name: 'A' }, { path: p2, name: 'B' }])).toThrow('唯一归属');
    const orphan = '/nonexistent/legacy-project';
    write(path.join(agent, 'memory', 'projects', `${slugOf(orphan)}.md`));
    expect(() => migrateLegacyMemoryFile(agent, `projects/${slugOf(orphan)}.md`, known)).toThrow('项目目录已不存在');
  });
});

describe('moving global topic memories into a project (user cleanup: project-specific files in global)', () => {
  it('moves root topic files, renames on collision, and guards reserved entries', () => {
    const agent = temp(), project = temp();
    write(path.join(agent, 'memory', 'litellm-deploy.md'), 'topic body');
    const r = moveMemoryFileToProject(agent, 'litellm-deploy.md', project);
    const dest = path.join(project, '.pi', 'memory', 'litellm-deploy.md');
    expect(r.movedTo).toBe(fs.realpathSync(dest));
    expect(fs.readFileSync(dest, 'utf8')).toBe('topic body');
    // 同名冲突自动加序号，不覆盖项目内已有文件
    write(path.join(agent, 'memory', 'litellm-deploy.md'), 'second');
    write(dest, 'existing');
    const r2 = moveMemoryFileToProject(agent, 'litellm-deploy.md', project);
    expect(path.basename(r2.movedTo)).toBe('litellm-deploy-2.md');
    expect(fs.readFileSync(r2.movedTo, 'utf8')).toBe('second');
    // 保留文件/子目录/不存在的文件拒绝；目标项目必选
    write(path.join(agent, 'memory', 'MEMORY.md'));
    expect(() => moveMemoryFileToProject(agent, 'MEMORY.md', project)).toThrow('主题文件');
    expect(() => moveMemoryFileToProject(agent, 'daily/2026-09-27.md', project)).toThrow('主题文件');
    expect(() => moveMemoryFileToProject(agent, 'nope.md', project)).toThrow();
    expect(() => moveMemoryFileToProject(agent, 'nope.md', '')).toThrow('目标项目');
    // 移动后项目视图自然收录
    expect(listMemoryFiles(agent, project).some(f => f.path === fs.realpathSync(r2.movedTo))).toBe(true);
  });
});
