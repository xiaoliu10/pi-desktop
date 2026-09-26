import fs from 'node:fs';
import path from 'node:path';
import { builtinMemoryDir, projectMemoryFile } from './memory-bridge';
import { authorizeProjectCwd, listExternalApps, type OpenWithDeps, runExternalApp } from './open-with';

/** Resolve only visible Markdown memories, never renderer-supplied absolute paths. */
export function resolveMemoryOpen(agentDir: string, rel: unknown, cwd: unknown, known: string[]): string {
  const project = cwd === undefined || cwd === '' ? undefined : authorizeProjectCwd(cwd, known);
  if (typeof rel !== 'string' || rel.length > 400 || !rel.endsWith('.md') || rel.includes('\\') || rel.includes('\0') || rel.split('/').some(s => !s || s === '.' || s === '..') || path.isAbsolute(rel)) throw new Error('记忆路径无效');
  const external = rel.startsWith('projects-external/');
  if (external && !project) throw new Error('请先选择项目');
  if (rel.startsWith('projects/') && (!project || rel !== `projects/${path.basename(projectMemoryFile(agentDir, project))}`)) throw new Error('记忆不属于所选项目');
  const anchor = fs.realpathSync(external ? project! : agentDir);
  const root = path.resolve(external ? path.join(project!, '.pi', 'memory') : builtinMemoryDir(agentDir));
  const realRoot = fs.realpathSync(root);
  if (!realRoot.startsWith(anchor + path.sep)) throw new Error('记忆目录越界');
  const lexicalTarget = path.resolve(root, external ? rel.slice('projects-external/'.length) : rel);
  // Reject links even within the root: aliases could bypass global/project scope checks.
  const base = external ? project! : path.resolve(agentDir);
  let cursor = base;
  for (const part of path.relative(base, lexicalTarget).split(path.sep)) {
    cursor = path.join(cursor, part);
    if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('记忆路径不允许符号链接');
  }
  const target = fs.realpathSync(lexicalTarget);
  if (!target.startsWith(realRoot + path.sep) || !target.endsWith('.md') || !fs.statSync(target).isFile()) throw new Error('记忆文件无效');
  return target;
}

export async function openMemoryFile(agentDir: string, rel: unknown, cwd: unknown, appId: unknown, known: string[], deps: OpenWithDeps & { reveal: (file: string) => void }) {
  // Re-detect on every invocation: stale UI or forged app ids cannot launch arbitrary apps.
  const apps = await listExternalApps(deps);
  const app = apps.find(a => a.id === appId && (a.kind === 'finder' || a.kind === 'editor'));
  if (!app) throw new Error('打开方式不可用，请选择已安装的编辑器或文件管理器');
  const file = resolveMemoryOpen(agentDir, rel, cwd, known);
  if (app.kind === 'finder') { deps.reveal(file); return; }
  await (deps.run ?? runExternalApp)('/usr/bin/open', ['-a', app.path, file]);
}
