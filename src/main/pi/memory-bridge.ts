import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Desktop 记忆衔接层（memory bridge）。目标：
 * 自动摘要只写项目 .pi/memory/daily，无项目时写 agentDir/memory/daily。
 * 全局与旧截断映射保留原样；旧映射可能碰撞，不能当作项目隔离边界。
 * 第三方插件的 memory 工具检索/注入范围独立管理，本桥不修改其配置。
 */

export interface MemoryAssistStatus {
  enabled: boolean;
  plugin: { kind: 'extension'; id: string; label?: string } | { kind: 'builtin' };
  builtinDir: string;
  hint: string;
}

/** 已知记忆插件（npm 裸名）；pi-memory 为内置默认（生态下载量最高）。 */
export const KNOWN_MEMORY_PLUGINS: ReadonlyArray<{ name: string; label: string }> = [
  { name: 'pi-memory', label: 'pi-memory' },
  { name: '@amaster.ai/pi-memory-mem0', label: 'Mem0 Memory' },
  { name: '@amaster.ai/pi-memory', label: 'Curated Memory' },
  { name: '@henryqw/pi-memory', label: 'Henry Memory' },
  { name: 'pi-memory-evolution', label: 'Memory Evolution' },
  { name: '@samfp/pi-memory', label: 'Samfp Memory' },
  { name: '@yandy0725/pi-memory', label: 'Filesystem Memory' },
  { name: '@fradser/pi-memory', label: 'Fradser Memory' },
];

/** 内置默认插件的安装源与展示名。 */
export const DEFAULT_MEMORY_SOURCE = 'npm:pi-memory';
export const DEFAULT_MEMORY_LABEL = 'pi-memory';

const SAFE_ID = /^[A-Za-z0-9._@/^:-]{1,120}$/;

/** Normalize an npm spec ("npm:name@ver") to a bare package name. */
function specToName(spec: string): string {
  return spec.replace(/^npm:/, '').replace(/@[^/@]+$/, '') || spec;
}

/** 探测 CLI 侧已安装/启用的记忆组件（settings.json packages 与 extensions 目录）。 */
export function detectMemoryPlugin(agentDir: string): { kind: 'extension'; id: string; label?: string } | { kind: 'builtin' } {
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8'));
    const pkgs = (settings.packages ?? []) as any[];
    for (const p of pkgs) {
      const s = String(typeof p === 'string' ? p : p?.source ?? '');
      if (!SAFE_ID.test(s)) continue;
      const known = KNOWN_MEMORY_PLUGINS.find((k) => k.name === specToName(s));
      if (known) return { kind: 'extension', id: s, label: known.label };
    }
  } catch { /* settings 可能不存在 */ }
  const extDir = path.join(agentDir, 'extensions');
  try {
    for (const name of fs.existsSync(extDir) ? fs.readdirSync(extDir) : []) {
      if (/memory|mem0|qmd/i.test(name) && /^[A-Za-z0-9._-]{1,80}$/.test(name)) return { kind: 'extension', id: name };
    }
  } catch { /* ignore */ }
  return { kind: 'builtin' };
}

/** Desktop 全局浏览/无项目摘要目录；第三方插件是否检索此目录取决于插件配置。 */
export function builtinMemoryDir(agentDir: string) { return path.join(agentDir, 'memory'); }

/**
 * 会话内存环境变量全集。pi 每次 launch 都是全新 RPC 进程，但 Desktop 自身（以及
 * 曾经连过的旧会话）的 PI_MEMORY_* / PI_DESKTOP_MEMORY_* 绝不能透传下去：
 * 全局会话必须落在插件默认根（~/.pi/agent/memory），项目会话才注入项目根。
 */
export const MEMORY_ENV_KEYS = [
  'PI_DESKTOP_MEMORY', 'PI_DESKTOP_MEMORY_CWD', 'PI_DESKTOP_MEMORY_DIR',
  'PI_MEMORY_DIR', 'PI_MEMORY_QMD_UPDATE', 'PI_MEMORY_NO_SEARCH',
] as const;

/** 清除继承的记忆环境（launch 前必须调用；之后再用 memorySessionEnv 按会话赋值）。 */
export function clearMemoryEnv(env: NodeJS.ProcessEnv): void {
  for (const key of MEMORY_ENV_KEYS) delete env[key];
}

/**
 * 单个会话的记忆环境（backend.launch 用；变量名以 pi-memory 0.4.2 README 为准）。
 * - 记忆关闭：返回空对象，什么都不注入。
 * - PI_DESKTOP_MEMORY*：desktop-memory 自动摘要（有项目写 <cwd>/.pi/memory/daily，
 *   无项目写全局 daily）——与本项目既有行为完全一致，不改动。
 * - 项目会话（cwd 为有效的绝对目录）：额外把 pi-memory 的记忆根指到 <cwd>/.pi/memory，
 *   实现 per-project 读写/注入隔离。同时设 PI_MEMORY_QMD_UPDATE=off 与
 *   PI_MEMORY_NO_SEARCH=1：插件的 qmd 集合名硬编码为 pi-memory（指向全局记忆目录），
 *   若把项目记忆 embed 进该集合会污染全局检索并与其它项目互相竞争；因此项目作用域下
 *   关闭后台重索引/嵌入与 per-turn 检索注入（插件未安装时这些变量无副作用；NO_SEARCH
 *   在默认 stable 快照模式下本就无行为，属纵深防御）。代价：项目会话没有语义检索，
 *   只有固定 4 文件注入（MEMORY/SCRATCHPAD/today/yesterday，上限 16K）。
 * - 无项目 / 目录失效：PI_MEMORY_* 保持 unset = 插件默认全局根，全局会话行为不变。
 */
export function memorySessionEnv(memory: { enabled: boolean; dir: string }, projectCwd: string | undefined, agentDir: string): Record<string, string> {
  if (!memory.enabled) return {};
  const env: Record<string, string> = {
    PI_DESKTOP_MEMORY: '1',
    PI_DESKTOP_MEMORY_CWD: projectCwd ?? '', // 项目摘要只写 cwd/.pi/memory/daily（空串 = 全局）。
    PI_DESKTOP_MEMORY_DIR: memory.dir || builtinMemoryDir(agentDir), // 无项目会话的全局兜底。
  };
  let valid = false;
  try {
    valid = typeof projectCwd === 'string' && projectCwd !== '' && path.isAbsolute(projectCwd)
      && !projectCwd.includes('\0') && fs.statSync(projectCwd).isDirectory();
  } catch { /* 目录消失/不可访问：按无项目处理，绝不注入半途失效的根。 */ }
  if (valid) {
    env.PI_MEMORY_DIR = path.join(projectCwd!, '.pi', 'memory');
    env.PI_MEMORY_QMD_UPDATE = 'off';
    env.PI_MEMORY_NO_SEARCH = '1';
  }
  return env;
}

/** Legacy lookup ONLY. Truncated slugs collide; never use this for new writes. */
export function projectMemoryFile(agentDir: string, projectCwd: string) {
  const slug = Buffer.from(path.resolve(projectCwd)).toString('base64url').slice(0, 48);
  return path.join(builtinMemoryDir(agentDir), 'projects', `${slug}.md`);
}

/** 面板/设置页展示用状态：当前使用哪条链路。 */
export function memoryAssistStatus(agentDir: string, enabled: boolean): MemoryAssistStatus {
  const plugin = detectMemoryPlugin(agentDir);
  return {
    enabled,
    plugin,
    builtinDir: builtinMemoryDir(agentDir),
    hint: `Desktop 自动摘要写入项目 .pi/memory/daily/，无项目时写入全局 daily/。${plugin.kind === 'extension'
      ? `检测到记忆插件 ${plugin.label ?? plugin.id}；开启记忆后，项目会话会把其记忆根注入为 <项目>/.pi/memory（读写在项目内闭环），并关闭 qmd 重索引与检索注入，避免项目记忆被写进插件硬编码的全局检索集合造成跨项目串扰；无项目会话仍使用全局记忆目录。`
      : '未检测到记忆插件（settings.json packages/extensions 均无）；自动保存摘要不代表已启用记忆检索，注入用的环境变量在插件缺失时无副作用。若安装 pi-memory，项目会话会启用 <项目>/.pi/memory 注入并关闭跨项目检索。'}`,
  };
}

export interface MemoryFileInfo { name: string; path: string; bytes: number; updatedAt: number; scope: 'global' | 'project'; entries: number; rel: string; /** 旧版 projects/ 映射文件的归属：能确定时是项目名（多项目共用时为「A、B（共用）」），否则缺失。 */ project?: string; /** 唯一归属项目的路径（共用/不可识别时缺失），可用于迁移。 */ projectPath?: string }

/** 旧版 projects/<slug>.md 的归属：display 展示名；path 唯一归属项目路径（共用/不可识别时缺失）；shared 多项目共用。 */
export interface LegacyAttribution { display?: string; path?: string; shared?: boolean }

export function legacyAttribution(rel: string, known: { path: string; name: string }[]): LegacyAttribution {
  const slug = rel.slice('projects/'.length, -'.md'.length);
  if (!slug) return {};
  const slugOf = (p: string) => Buffer.from(path.resolve(p)).toString('base64url').slice(0, 48);
  const exact = known.filter(p => slugOf(p.path) === slug);
  if (exact.length === 1) return { display: exact[0].name, path: exact[0].path };
  if (exact.length > 1) return { display: `${exact.map(p => p.name).join('、')}（共用）`, shared: true };
  try {
    const decoded = Buffer.from(slug, 'base64url').toString('utf8');
    if (!decoded.startsWith('/') || /[\u0000-\u001f]/.test(decoded)) return {};
    const truncated = slug.length >= 48;
    if (!truncated) {
      const reg = known.find(p => path.resolve(p.path) === decoded);
      return reg ? { display: reg.name, path: reg.path } : { display: decoded, path: decoded };
    }
    const byPrefix = known.filter(p => p.path.startsWith(decoded));
    if (byPrefix.length === 1) return { display: byPrefix[0].name, path: byPrefix[0].path };
    if (byPrefix.length > 1) return { display: `${byPrefix.map(p => p.name).join('、')}（共用）`, shared: true };
    return { display: `${decoded}…` };
  } catch { return {}; }
}

/** 兼容旧调用：只取展示名。 */
export function legacyProjectName(rel: string, known: { path: string; name: string }[]): string | undefined {
  return legacyAttribution(rel, known).display;
}

/** 条目标记：`<!-- 2026-06-07 10:12:03 [id] -->`（pi-memory 与内置桥共用的时间戳行）。 */
const ENTRY_MARKER_RE = /<!--\s*\d{4}-\d{2}-\d{2}/;

function countEntries(file: string): number {
  try {
    let n = 0;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) if (ENTRY_MARKER_RE.test(line)) n += 1;
    return n;
  } catch { return 0; }
}

/** Validate every component below the trusted project/agent anchor, including .pi/memory. */
function checkedPath(anchor: string, parts: string[]): string {
  let cursor = fs.realpathSync(anchor);
  if (!fs.statSync(cursor).isDirectory()) throw new Error('记忆根目录无效');
  for (const part of parts) {
    cursor = path.join(cursor, part);
    if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('路径无效：记忆路径不允许符号链接');
  }
  return cursor;
}

function validateProject(projectCwd?: string): boolean {
  if (projectCwd === undefined || projectCwd === '') return false;
  if (typeof projectCwd !== 'string' || !path.isAbsolute(projectCwd) || projectCwd.includes('\0')) throw new Error('项目路径无效');
  if (!fs.statSync(projectCwd).isDirectory()) throw new Error('项目目录无效');
  return true;
}

/** Shared list/read/open scope boundary. Legacy lookup is compatibility-only, not ownership proof. */
export function resolveMemoryFile(agentDir: string, rel: unknown, projectCwd?: string): string {
  if (typeof rel !== 'string' || rel.length > 400 || !rel.endsWith('.md') || rel.includes('\\') || rel.includes('\0') || path.isAbsolute(rel) || rel.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('路径无效：只支持记忆 markdown 文件');
  const project = validateProject(projectCwd);
  const external = rel.startsWith('projects-external/');
  if (external && !project) throw new Error('请先选择项目');
  if (project) {
    if (!external && rel !== `projects/${path.basename(projectMemoryFile(agentDir, projectCwd!))}`) throw new Error('记忆不属于所选项目');
  }
  // 全局视图允许读旧版 projects/ 映射：它们本就在全局记忆目录内，设置页已尽量标注归属项目。
  const target = external
    ? checkedPath(projectCwd!, ['.pi', 'memory', ...rel.slice('projects-external/'.length).split('/')])
    : checkedPath(agentDir, ['memory', ...rel.split('/')]);
  if (!fs.statSync(target).isFile()) throw new Error('不是记忆文件');
  return target;
}

/** Recursive project-local view plus honestly labelled legacy lookup; never fall back to global. */
export function listMemoryFiles(agentDir: string, projectCwd?: string, knownProjects: { path: string; name: string }[] = []): MemoryFileInfo[] {
  const project = validateProject(projectCwd);
  const out: MemoryFileInfo[] = [];
  const add = (rel: string) => {
    try {
      const full = resolveMemoryFile(agentDir, rel, projectCwd);
      const st = fs.statSync(full);
      out.push({ name: path.basename(rel), path: full, bytes: st.size, updatedAt: st.mtimeMs, scope: project ? 'project' : 'global', entries: countEntries(full), rel,
        ...(!project && rel.startsWith('projects/') ? (() => { const a = legacyAttribution(rel, knownProjects); return { project: a.display, projectPath: a.path }; })() : {}) });
    } catch { /* Missing/linked/inaccessible entries are not visible. */ }
  };
  const anchor = project ? projectCwd! : agentDir;
  const base = project ? ['.pi', 'memory'] : ['memory'];
  const visit = (parts: string[]) => {
    let full: string;
    try { full = checkedPath(anchor, [...base, ...parts]); } catch { return; }
    const st = fs.lstatSync(full);
    if (st.isDirectory()) {
      let names: string[];
      try { names = fs.readdirSync(full).sort(); } catch { return; }
      for (const name of names) {
        // 全局视图列出旧版 projects/（带归属标注）；projects-external 是项目本地文件的指针，仍只在项目视图出现。
        if (!project && !parts.length && name === 'projects-external') continue;
        visit([...parts, name]);
      }
    } else if (st.isFile() && parts.at(-1)?.endsWith('.md')) {
      add(`${project ? 'projects-external/' : ''}${parts.join('/')}`);
    }
  };
  visit([]);
  if (project) add(`projects/${path.basename(projectMemoryFile(agentDir, projectCwd!))}`);
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 把旧版 projects/ 映射文件迁回唯一归属项目：<项目>/.pi/memory/legacy/<slug>.md。共用/不可识别/项目目录缺失一律拒绝。 */
export function migrateLegacyMemoryFile(agentDir: string, rel: unknown, knownProjects: { path: string; name: string }[]): { movedTo: string } {
  if (typeof rel !== 'string' || !rel.startsWith('projects/') || !rel.endsWith('.md')) throw new Error('只能迁移旧版 projects/ 映射文件');
  const full = resolveMemoryFile(agentDir, rel, undefined);
  const attr = legacyAttribution(rel, knownProjects);
  if (attr.shared || !attr.path) throw new Error('无法确定唯一归属项目（共用或未识别），请手动处理');
  const project = path.resolve(attr.path);
  let dirStat: fs.Stats;
  try { dirStat = fs.statSync(project); } catch { throw new Error('项目目录已不存在，无法迁移'); }
  if (!dirStat.isDirectory()) throw new Error('项目路径不是目录，无法迁移');
  const destDir = path.join(project, '.pi', 'memory', 'legacy');
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(fs.realpathSync(destDir), path.basename(full));
  if (fs.existsSync(dest)) throw new Error('项目内已存在同名文件，未迁移');
  try { fs.renameSync(full, dest); } catch { /* 跨卷：复制后删除 */ fs.copyFileSync(full, dest); fs.unlinkSync(full); }
  return { movedTo: dest };
}

/** 把全局记忆中的主题文件移入指定项目 <项目>/.pi/memory/<name>.md（同名自动加序号）。
 *  仅限根层主题文件：MEMORY.md / SCRATCHPAD.md / daily、projects、recovery 等保留位不可移。 */
export function moveMemoryFileToProject(agentDir: string, rel: unknown, projectCwd: unknown): { movedTo: string } {
  if (typeof rel !== 'string' || rel.includes('/') || !rel.endsWith('.md') || ['MEMORY.md', 'SCRATCHPAD.md'].includes(rel))
    throw new Error('只能移动全局记忆中的主题文件（不含 MEMORY.md / SCRATCHPAD.md 与保留目录）');
  if (typeof projectCwd !== 'string' || !validateProject(projectCwd)) throw new Error('请选择目标项目');
  const full = resolveMemoryFile(agentDir, rel, undefined);
  const destDir = path.join(projectCwd, '.pi', 'memory');
  fs.mkdirSync(destDir, { recursive: true });
  const base = path.basename(rel);
  const stem = base.slice(0, -'.md'.length);
  let dest = path.join(fs.realpathSync(destDir), base);
  for (let n = 2; fs.existsSync(dest); n += 1) dest = path.join(fs.realpathSync(destDir), `${stem}-${n}.md`);
  try { fs.renameSync(full, dest); } catch { /* 跨卷：复制后删除 */ fs.copyFileSync(full, dest); fs.unlinkSync(full); }
  return { movedTo: dest };
}

/** Preview uses exactly the same scope/link checks as external opening. */
export function readMemoryFileContent(agentDir: string, rel: unknown, projectCwd?: string): string {
  const target = resolveMemoryFile(agentDir, rel, projectCwd);
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('不是文件');
    if (stat.size > 512 * 1024) throw new Error('文件超过 512 KiB，请在外部编辑器查看');
    return fs.readFileSync(fd, 'utf8');
  } finally { fs.closeSync(fd); }
}

/** ZCode 风格相对时间：「刚刚 / 今天 13:35 / 周二 19:46 / 9月1日」。 */
export function formatMemoryTime(mtimeMs: number, now = Date.now()): string {
  const diff = now - mtimeMs;
  if (diff < 60_000) return '刚刚';
  const d = new Date(mtimeMs);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (diff < 24 * 3600_000 && d.getDate() === new Date(now).getDate()) return `今天 ${hm}`;
  if (diff < 7 * 24 * 3600_000) return `${['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]} ${hm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

export function defaultAgentDir(): string {
  return path.join(os.homedir(), '.pi', 'agent');
}
