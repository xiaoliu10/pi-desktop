import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
export const modes = ['plan', 'ask', 'autoEdit', 'fullAccess'];
const readers = new Set(['read', 'grep', 'find', 'ls']);
const writers = new Set(['edit', 'write']);
export function resolveTarget(cwd, inputPath = '.') {
  if (typeof inputPath !== 'string' || inputPath.includes('\0')) throw new Error('无效路径');
  const absolute = path.resolve(cwd, inputPath === '~' ? os.homedir() : inputPath.startsWith('~/') ? path.join(os.homedir(), inputPath.slice(2)) : inputPath);
  let current = absolute;
  const missing = [];
  while (!fs.existsSync(current)) {
    // Dangling symlinks must not be treated as new files.
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('目标包含失效符号链接'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const parent = path.dirname(current);
    if (parent === current) throw new Error('路径无法解析');
    missing.unshift(path.basename(current)); current = parent;
  }
  return path.join(fs.realpathSync(current), ...missing);
}
export function classify({ mode, tool, input, cwd, builtin }) {
  if (!modes.includes(mode)) return { action: 'deny', reason: '未知访问模式' };
  if (mode === 'fullAccess') return { action: 'allow', reason: '完全访问' };
  // ask_user_question 是 Desktop 自带的纯 UI 提问工具，无文件/命令副作用，任何模式放行。
  if (tool === 'ask_user_question') return { action: 'allow', reason: 'Desktop 提问组件，无副作用' };
  if (!builtin) return { action: mode === 'plan' ? 'deny' : 'ask', reason: '扩展或未知工具，无法确认副作用' };
  if (!readers.has(tool) && !writers.has(tool)) return { action: mode === 'plan' ? 'deny' : 'ask', reason: '命令可能修改文件、联网或启动其他程序' };
  let target, root;
  try { target = resolveTarget(cwd, input.path ?? '.'); root = fs.realpathSync(cwd); }
  catch (e) { return { action: 'deny', reason: e.message }; }
  const relative = path.relative(root, target);
  const inside = relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  const sensitive = target.split(path.sep).some(p => /^(\.env(?:\..*)?|\.git|\.pi|\.ssh|\.aws|\.gnupg|\.codex|\.npmrc|\.netrc|auth\.json|credentials(?:\.json)?|AGENTS\.md)$/i.test(p));
  const write = writers.has(tool);
  if (mode === 'plan' && write) return { action: 'deny', reason: '计划模式不允许修改文件', target };
  if (!inside || sensitive) return { action: mode === 'plan' ? 'deny' : 'ask', reason: inside ? '敏感文件或执行配置' : '目标位于项目目录之外', target };
  if (!write) return { action: 'allow', reason: '项目内只读操作', target };
  return { action: mode === 'autoEdit' ? 'allow' : 'ask', reason: mode === 'autoEdit' ? '自动编辑项目文件' : '修改文件前需要确认', target };
}
export function fileRevision(target) {
  if (!target) return undefined;
  try { const stat = fs.statSync(target); return `${fs.realpathSync(target)}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`; }
  catch (e) { if (e.code === 'ENOENT') return 'missing'; throw e; }
}
export function approvalMessage(event, decision, cwd) {
  let diff = '';
  if (decision.target && writers.has(event.toolName)) {
    let before = '';
    try {
      if (fs.statSync(decision.target).size > 1024 * 1024) return `工作目录：${cwd}\n原因：${decision.reason}\n目标：${decision.target}\n文件超过 1 MiB，请先在编辑器核对。\n参数：\n${JSON.stringify(event.input, null, 2)}`;
      before = fs.readFileSync(decision.target, 'utf8');
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const old = event.toolName === 'edit' ? String(event.input.oldText ?? '') : before;
    const next = event.toolName === 'edit' ? String(event.input.newText ?? '') : String(event.input.content ?? '');
    diff = `\n变更预览（${event.toolName === 'edit' ? '替换片段' : '完整文件替换'}）：\n--- ${decision.target}\n+++ ${decision.target}\n${old.split('\n').map(l => '- ' + l).join('\n')}\n${next.split('\n').map(l => '+ ' + l).join('\n')}\n`;
  }
  return `工作目录：${cwd}\n工具：${event.toolName}\n原因：${decision.reason}${diff}\n完整参数：\n${JSON.stringify(event.input, null, 2)}`;
}
export const inputDigest = input => createHash('sha256').update(JSON.stringify(input)).digest('hex');

/** 审批卡工具行元数据：文件名/相对目录/增删行数（bash 为命令摘要）。随 title 编码传给渲染端。 */
export function approvalMeta(event, decision, cwd) {
  const tool = event.toolName;
  const lineCount = text => (text ? String(text).split('\n').length : 0);
  if (decision.target && (tool === 'edit' || tool === 'write')) {
    const relative = path.relative(cwd, decision.target) || decision.target;
    const name = path.basename(relative);
    const dir = path.dirname(relative);
    const add = tool === 'edit' ? lineCount(event.input.newText) : lineCount(event.input.content);
    const del = tool === 'edit' ? lineCount(event.input.oldText) : 0;
    return { name, dir: dir === '.' ? '' : dir, add, del: del || undefined, cmd: '' };
  }
  if (tool === 'bash' || tool === 'exec') {
    const cmd = String(event.input?.command ?? event.input?.script ?? '').replace(/\s+/g, ' ').trim();
    return { name: cmd.slice(0, 80) || tool, dir: '', add: undefined, del: undefined, cmd: cmd.slice(0, 80) };
  }
  const label = String(event.input?.path ?? event.input?.file_path ?? '').split('/').pop();
  return { name: label || tool, dir: '', add: undefined, del: undefined, cmd: '' };
}
