import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Desktop 记忆衔接层（memory bridge）。目标：
 * 1. CLI 已启用记忆插件（如 pi-memory / 其他市场组件）→ 复用其能力与目录；
 * 2. 未启用 → Desktop 回退到内置桥（agentDir/memory/，pi-memory 同款 markdown 约定）；
 * 3. 自动整理由 extensions/desktop-memory 扩展在会话内执行（agent_end → LLM 摘要 →
 *    追加 daily 日志），Desktop 只负责开关与目录注入，不做跨进程写。
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

/** 记忆存储目录：pi 生态约定为 agentDir/memory（内置桥与 pi-memory 同目录，安装即接管）。 */
export function builtinMemoryDir(agentDir: string) { return path.join(agentDir, 'memory'); }

export function projectMemoryFile(agentDir: string, projectCwd: string) {
  const slug = Buffer.from(path.resolve(projectCwd)).toString('base64url').slice(0, 48);
  return path.join(builtinMemoryDir(agentDir), 'projects', `${slug}.md`);
}

/** 召回：读取项目记忆全文（内置桥约定为追加式 Markdown）。 */
export function readProjectMemory(agentDir: string, projectCwd: string): string {
  try { return fs.readFileSync(projectMemoryFile(agentDir, projectCwd), 'utf8'); } catch { return ''; }
}

/** 总结落盘：向项目记忆追加一段摘要。 */
export function appendProjectMemory(agentDir: string, projectCwd: string, digest: string) {
  const file = projectMemoryFile(agentDir, projectCwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, digest.endsWith('\n') ? digest : `${digest}\n`, { mode: 0o600 });
}

/** 面板/设置页展示用状态：当前使用哪条链路。 */
export function memoryAssistStatus(agentDir: string, enabled: boolean): MemoryAssistStatus {
  const plugin = detectMemoryPlugin(agentDir);
  return {
    enabled,
    plugin,
    builtinDir: builtinMemoryDir(agentDir),
    hint: plugin.kind === 'extension'
      ? `已启用记忆插件 ${plugin.label ?? plugin.id}，自动整理将写入其记忆目录`
      : '未检测到记忆插件，将使用内置桥（agentDir/memory/）；可一键安装 pi-memory 获得检索增强',
  };
}

export interface MemoryFileInfo { name: string; path: string; bytes: number; updatedAt: number; scope: 'global' | 'project'; entries: number; rel: string; }

/** 条目标记：`<!-- 2026-06-07 10:12:03 [id] -->`（pi-memory 与内置桥共用的时间戳行）。 */
const ENTRY_MARKER_RE = /<!--\s*\d{4}-\d{2}-\d{2}/;

function countEntries(file: string): number {
  try {
    let n = 0;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) if (ENTRY_MARKER_RE.test(line)) n += 1;
    return n;
  } catch { return 0; }
}

/** 列出记忆目录的 markdown 文件（顶层 + daily/ + projects/），最近修改在前。 */
export function listMemoryFiles(agentDir: string, projectCwd?: string): MemoryFileInfo[] {
  const out: MemoryFileInfo[] = [];
  const root = builtinMemoryDir(agentDir);
  const visit = (rel: string, scope: 'global' | 'project') => {
    const full = path.join(root, rel);
    let stats: fs.Stats;
    try { stats = fs.statSync(full); } catch { return; }
    if (stats.isDirectory()) {
      let names: string[] = [];
      try { names = fs.readdirSync(full).sort(); } catch { return; }
      for (const name of names) visit(rel ? `${rel}/${name}` : name, scope);
      return;
    }
    if (!stats.isFile() || !rel.endsWith('.md')) return;
    out.push({ name: path.basename(rel), path: full, bytes: stats.size, updatedAt: stats.mtimeMs, scope, entries: countEntries(full), rel });
  };
  visit('', 'global');
  if (projectCwd) {
    try {
      const dir = path.join(projectCwd, '.pi', 'memory');
      for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
        if (!name.endsWith('.md')) continue;
        const full = path.join(dir, name);
        try { const st = fs.statSync(full); if (st.isFile()) out.push({ name, path: full, bytes: st.size, updatedAt: st.mtimeMs, scope: 'project', entries: countEntries(full), rel: path.join('projects-external', name) }); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 读取记忆文件内容（设置页预览）。rel 必须落在记忆目录内且是 markdown。 */
export function readMemoryFileContent(agentDir: string, rel: string): string {
  const root = path.resolve(builtinMemoryDir(agentDir));
  if (typeof rel !== 'string' || rel.length > 400 || !rel.endsWith('.md')) throw new Error('只支持查看记忆 markdown 文件');
  const target = path.resolve(root, rel);
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error('路径无效');
  const stat = fs.statSync(target);
  if (!stat.isFile()) throw new Error('不是文件');
  if (stat.size > 512 * 1024) throw new Error('文件超过 512 KiB，请在外部编辑器查看');
  return fs.readFileSync(target, 'utf8');
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
