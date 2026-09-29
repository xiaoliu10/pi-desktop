import { resolveMemoryFile } from './memory-bridge';
import { authorizeProjectCwd, listExternalApps, type OpenWithDeps, runExternalApp } from './open-with';

/** Resolve only visible Markdown memories, never renderer-supplied absolute paths. */
export function resolveMemoryOpen(agentDir: string, rel: unknown, cwd: unknown, known: string[]): string {
  const project = cwd === undefined || cwd === '' ? undefined : authorizeProjectCwd(cwd, known);
  return resolveMemoryFile(agentDir, rel, project);
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
