import fs from 'node:fs';
import path from 'node:path';

/**
 * Desktop 记忆衔接层（memory bridge）。目标：
 * 1. CLI 已启用记忆插件（如 pi-memory / 其他市场组件）→ 复用其能力；
 * 2. 未启用 → Desktop 回退到内置桥（agentDir/memory/，约定式 Markdown 存储）；
 * 3. 统一的状态/读写接口，后续可对接任意记忆组件（实现相同三个原语即可）。
 */

export interface MemoryAssistStatus {
  enabled: boolean;
  plugin: { kind: 'extension'; id: string } | { kind: 'builtin' };
  builtinDir: string;
  hint: string;
}

const MEMORY_EXT = /memory|mem0|qmd|letta|zed-memory/i;
const SAFE_ID = /^[A-Za-z0-9._@/^:-]{1,120}$/;

/** 探测 CLI 侧已安装/启用的记忆组件（settings.json packages 与 extensions 目录）。 */
export function detectMemoryPlugin(agentDir: string): { kind: 'extension'; id: string } | { kind: 'builtin' } {
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8'));
    const pkgs = (settings.packages ?? []) as any[];
    for (const p of pkgs) {
      const s = String(typeof p === 'string' ? p : p?.source ?? '');
      if (MEMORY_EXT.test(s) && SAFE_ID.test(s)) return { kind: 'extension', id: s };
    }
  } catch { /* settings 可能不存在 */ }
  const extDir = path.join(agentDir, 'extensions');
  try {
    for (const name of fs.existsSync(extDir) ? fs.readdirSync(extDir) : []) {
      if (MEMORY_EXT.test(name) && /^[A-Za-z0-9._-]{1,80}$/.test(name)) return { kind: 'extension', id: name };
    }
  } catch { /* ignore */ }
  return { kind: 'builtin' };
}

/** 内置桥的存储布局：agentDir/memory/projects/<slug>.md，按项目隔离。 */
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
      ? `检测到记忆组件 ${plugin.id}，将复用其能力做项目级总结与召回`
      : '未检测到记忆插件，将使用 Desktop 内置桥（agentDir/memory/）；推荐安装 npm:pi-memory 获得检索增强',
  };
}

export interface MemoryFileInfo { name: string; path: string; bytes: number; updatedAt: number; scope: 'global' | 'project'; }

/** 列出记忆文件（内置桥 + pi-memory 约定目录），供记忆管理页展示。 */
export function listMemoryFiles(agentDir: string, projectCwd?: string): MemoryFileInfo[] {
  const out: MemoryFileInfo[] = [];
  const scan = (dir: string, scope: 'global' | 'project') => {
    try {
      if (!fs.existsSync(dir)) return;
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.md')) continue;
        const full = path.join(dir, name);
        try { const st = fs.statSync(full); if (st.isFile()) out.push({ name, path: full, bytes: st.size, updatedAt: st.mtimeMs, scope }); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  };
  scan(builtinMemoryDir(agentDir), 'global');                       // pi-memory 约定：agentDir/memory/*.md + MEMORY.md
  scan(path.join(builtinMemoryDir(agentDir), 'projects'), 'project'); // 内置桥按项目隔离
  if (projectCwd) scan(path.join(projectCwd, '.pi', 'memory'), 'project'); // 项目级 .pi/memory
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}
