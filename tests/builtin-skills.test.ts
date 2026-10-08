import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { syncBuiltinSkills, syncBuiltinPrompts } from '../src/main/pi/builtin-skills';

// P0 回归守卫：sync 调用必须在 PiHost 构造之后（host 变量此前为 undefined，
// 错误位置会被 catch 吞成静默失效——单测层测不到装配顺序）。
it('main/index.ts 中内置资源同步位于 host = new PiHost 之后', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  const hostAssign = src.indexOf('host = new PiHost(');
  expect(hostAssign).toBeGreaterThan(-1);
  expect(src.indexOf('syncBuiltinSkills(host.environment.agentDir')).toBeGreaterThan(hostAssign);
  expect(src.indexOf('syncBuiltinPrompts(host.environment.agentDir')).toBeGreaterThan(hostAssign);
});

const dirs: string[] = [];
function makeDir(): string { const d = mkdtempSync(join(tmpdir(), 'builtin-skills-')); dirs.push(d); return d; }
function writeSkill(root: string, name: string, body: string, extra?: string): void {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, 'SKILL.md'), body);
  if (extra !== undefined) { mkdirSync(join(root, name, 'scripts'), { recursive: true }); writeFileSync(join(root, name, 'scripts', 'tool.py'), extra); }
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('syncBuiltinSkills', () => {
  it('首次同步：复制技能与子文件，manifest 记录源 hash', () => {
    const agent = makeDir(), source = makeDir();
    writeSkill(source, 'pptx', '---\nname: pptx\n---\n# PPT', 'print(1)');
    const r = syncBuiltinSkills(agent, source);
    expect(r.synced).toEqual(['pptx']);
    expect(readFileSync(join(agent, 'skills', 'pptx', 'SKILL.md'), 'utf8')).toContain('# PPT');
    expect(readFileSync(join(agent, 'skills', 'pptx', 'scripts', 'tool.py'), 'utf8')).toBe('print(1)');
    const manifest = JSON.parse(readFileSync(join(agent, 'skills', '.pi-desktop-builtin.json'), 'utf8'));
    expect(manifest.pptx).toMatch(/^[0-9a-f]{40}$/);
  });

  it('升级：内置版本变化且用户未改 → 覆盖更新', () => {
    const agent = makeDir(), source = makeDir();
    writeSkill(source, 'docx', 'v1');
    syncBuiltinSkills(agent, source);
    writeSkill(source, 'docx', 'v2');
    const r = syncBuiltinSkills(agent, source);
    expect(r.synced).toEqual(['docx']);
    expect(readFileSync(join(agent, 'skills', 'docx', 'SKILL.md'), 'utf8')).toBe('v2');
  });

  it('用户改过 → 永不覆盖，即使内置升级', () => {
    const agent = makeDir(), source = makeDir();
    writeSkill(source, 'xlsx', 'shipped');
    syncBuiltinSkills(agent, source);
    writeFileSync(join(agent, 'skills', 'xlsx', 'SKILL.md'), 'my local edits');
    writeSkill(source, 'xlsx', 'v2');
    const r = syncBuiltinSkills(agent, source);
    expect(r.skipped).toEqual(['xlsx']);
    expect(readFileSync(join(agent, 'skills', 'xlsx', 'SKILL.md'), 'utf8')).toBe('my local edits');
  });

  it('无 manifest 记录的同名目录（用户自建）视为已改，跳过', () => {
    const agent = makeDir(), source = makeDir();
    mkdirSync(join(agent, 'skills', 'pptx'), { recursive: true });
    writeFileSync(join(agent, 'skills', 'pptx', 'SKILL.md'), 'user made');
    writeSkill(source, 'pptx', 'shipped');
    const r = syncBuiltinSkills(agent, source);
    expect(r.skipped).toEqual(['pptx']);
    expect(readFileSync(join(agent, 'skills', 'pptx', 'SKILL.md'), 'utf8')).toBe('user made');
  });

  it('已最新 → 不动（synced 为空），manifest 持久稳定', () => {
    const agent = makeDir(), source = makeDir();
    writeSkill(source, 'pdf', 'same');
    syncBuiltinSkills(agent, source);
    const before = readFileSync(join(agent, 'skills', '.pi-desktop-builtin.json'), 'utf8');
    expect(syncBuiltinSkills(agent, source).synced).toEqual([]);
    expect(readFileSync(join(agent, 'skills', '.pi-desktop-builtin.json'), 'utf8')).toBe(before);
  });

  it('中断拷贝自愈：目标内容已是最新但缺记录 → 只补记录不重拷；同名文件/坏目录不毒化全局', () => {
    const agent = makeDir(), source = makeDir();
    writeSkill(source, 'pptx', 'same content');
    // 模拟中断拷贝残留：内容一致但 manifest 无记录（另一次同步的 manifest 只记了别人）
    mkdirSync(join(agent, 'skills', 'pptx'), { recursive: true });
    writeFileSync(join(agent, 'skills', 'pptx', 'SKILL.md'), 'same content');
    // 同名文件 + 空源目录（dirHash 会失败）不拖垮其余技能
    writeFileSync(join(agent, 'skills', 'docx'), 'not a dir');
    writeSkill(source, 'xlsx', 'ok');
    mkdirSync(join(source, 'docx')); // 空目录：源侧 dirHash 无 SKILL.md → 不在 bundled 列表，但同名文件仍在目标
    const r = syncBuiltinSkills(agent, source);
    expect(r.synced).toEqual(['pptx', 'xlsx']);
    const manifest = JSON.parse(readFileSync(join(agent, 'skills', '.pi-desktop-builtin.json'), 'utf8'));
    expect(manifest.pptx).toMatch(/^[0-9a-f]{40}$/);
  });

  it('内置清单移除技能：未被改的副本被清理，已改的保留但移出 manifest', () => {
    const agent = makeDir(), source = makeDir();
    writeSkill(source, 'gone-clean', 'x');
    writeSkill(source, 'gone-edited', 'y');
    syncBuiltinSkills(agent, source);
    rmSync(join(source, 'gone-clean'), { recursive: true, force: true }); rmSync(join(source, 'gone-edited'), { recursive: true, force: true });
    writeFileSync(join(agent, 'skills', 'gone-edited', 'SKILL.md'), 'tweaked');
    const r = syncBuiltinSkills(agent, source);
    expect(r.removed).toEqual(['gone-clean']);
    expect(existsSync(join(agent, 'skills', 'gone-clean'))).toBe(false);
    expect(existsSync(join(agent, 'skills', 'gone-edited'))).toBe(true);
    expect(Object.keys(JSON.parse(readFileSync(join(agent, 'skills', '.pi-desktop-builtin.json'), 'utf8')))).toEqual([]);
  });

  it('源目录不存在 → 空操作不报错', () => {
    const agent = makeDir();
    expect(syncBuiltinSkills(agent, join(agent, 'nope'))).toEqual({ synced: [], skipped: [], removed: [] });
  });

  it('仓库内置资源包含四个办公技能且 frontmatter 合法', () => {
    const source = join(__dirname, '..', 'resources', 'builtin-skills');
    for (const name of ['pptx', 'docx', 'xlsx', 'pdf']) {
      const md = readFileSync(join(source, name, 'SKILL.md'), 'utf8');
      expect(md).toMatch(/^---\r?\nname: /);
      expect(md).toContain('builtin: true');
      expect(md).toMatch(/^description: "[^"]{20,}/m);
    }
  });

  it('prompts 同步：单文件形态独立 manifest，升级/用户改跳过/移除清理', () => {
    const agent = makeDir(), source = makeDir();
    writeFileSync(join(source, 'weekly-report.md'), 'v1');
    writeFileSync(join(source, 'check-failures.md'), 'v1');
    const r1 = syncBuiltinPrompts(agent, source);
    expect(r1.synced.sort()).toEqual(['check-failures.md', 'weekly-report.md']);
    expect(existsSync(join(agent, 'prompts', 'weekly-report.md'))).toBe(true);
    // 升级
    writeFileSync(join(source, 'weekly-report.md'), 'v2');
    expect(syncBuiltinPrompts(agent, source).synced).toEqual(['weekly-report.md']);
    expect(readFileSync(join(agent, 'prompts', 'weekly-report.md'), 'utf8')).toBe('v2');
    // 用户改 → 永不覆盖
    writeFileSync(join(agent, 'prompts', 'check-failures.md'), 'mine');
    writeFileSync(join(source, 'check-failures.md'), 'v2');
    const r2 = syncBuiltinPrompts(agent, source);
    expect(r2.skipped).toEqual(['check-failures.md']);
    expect(readFileSync(join(agent, 'prompts', 'check-failures.md'), 'utf8')).toBe('mine');
    // 从内置清单移除：未改副本清理，已改保留
    rmSync(join(source, 'weekly-report.md'));
    const r3 = syncBuiltinPrompts(agent, source);
    expect(r3.removed).toEqual(['weekly-report.md']);
    expect(existsSync(join(agent, 'prompts', 'weekly-report.md'))).toBe(false);
    expect(existsSync(join(agent, 'prompts', 'check-failures.md'))).toBe(true);
  });

  it('同名形态冲突（目标同名文件/目录互错）不覆盖用户之物', () => {
    const agent = makeDir(), source = makeDir();
    writeSkill(source, 'pptx', 'shipped');
    mkdirSync(join(agent, 'skills'), { recursive: true });
    writeFileSync(join(agent, 'skills', 'pptx'), 'user file'); // 同名文件 vs 内置目录
    writeFileSync(join(source, 'note.md'), 'prompt');
    mkdirSync(join(agent, 'prompts'), { recursive: true });
    mkdirSync(join(agent, 'prompts', 'note.md'), { recursive: true }); // 同名目录 vs 内置文件
    const r = syncBuiltinSkills(agent, source);
    const p = syncBuiltinPrompts(agent, source);
    expect(r.skipped).toEqual(['pptx']);
    expect(p.skipped).toEqual(['note.md']);
  });

  it('仓库内置提示词模板 frontmatter 合法（description/命令名=文件名）', () => {
    const source = join(__dirname, '..', 'resources', 'builtin-prompts');
    const files = readdirSync(source).filter(f => f.endsWith('.md')).sort();
    expect(files.length).toBe(12);
    for (const f of files) {
      const md = readFileSync(join(source, f), 'utf8');
      expect(md, f).toMatch(/^---\r?\ndescription: [^\r\n]{10,}\r?\n/);
      expect(md, f).not.toMatch(/plugin:\/\/|zcode-plugins-official/); // 不残留 ZCode 插件引用
      expect(md, f).not.toContain('${@'); // 只用支持的替换语法
    }
  });
});
