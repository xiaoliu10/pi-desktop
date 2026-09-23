import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { fileDiff } from '../../shared/diff';
import type { FileDiff } from '../../shared/types';
import type { ToolSchema } from '../providers/base';

/**
 * Workspace tools available to the agent. All paths are resolved against the
 * project root and confined to it. Read-only tools are "safe"; write/execute
 * tools require permission.
 */

export interface ToolContext {
  root: string;
  log: (msg: string) => void;
}

export interface ToolResult {
  ok: boolean;
  output?: string;
  error?: string;
  diff?: FileDiff;
  truncated?: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  kind: 'read' | 'write' | 'exec';
  /** One-line human summary of an invocation, shown in permission prompts. */
  summarize: (args: Record<string, unknown>) => string;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

const MAX_OUTPUT = 40_000;
const MAX_FILE_READ = 100_000;

function truncate(text: string, limit = MAX_OUTPUT): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  return { text: text.slice(0, limit) + `\n… [truncated ${text.length - limit} chars]`, truncated: true };
}

function resolveInRoot(root: string, p: unknown): string {
  const rel = typeof p === 'string' && p.length ? p : '.';
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`Path escapes project root: ${rel}`);
  }
  return abs;
}

function relPath(root: string, abs: string): string {
  return path.relative(root, abs) || '.';
}

function str(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' ? v : undefined;
}

function num(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  return typeof v === 'number' ? v : undefined;
}

function bool(args: Record<string, unknown>, key: string): boolean {
  return args[key] === true;
}

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', 'target',
  '__pycache__', '.venv', 'venv', '.idea', '.vscode', 'coverage',
]);
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz',
  '.tar', '.rar', '.7z', '.exe', '.dll', '.dylib', '.so', '.bin', '.woff',
  '.woff2', '.ttf', '.eot', '.mp3', '.mp4', '.mov', '.avi', '.sqlite', '.db',
]);

export const TOOLS: ToolDef[] = [
  {
    name: 'list_dir',
    kind: 'read',
    description: 'List the entries of a directory inside the project. Use it to explore the project structure.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path relative to the project root. Defaults to the root.' },
      },
    },
    summarize: (args) => `list_dir ${str(args, 'path') || '.'}`,
    run: async (args, ctx) => {
      const abs = resolveInRoot(ctx.root, str(args, 'path'));
      const entries = fs.readdirSync(abs, { withFileTypes: true });
      entries.sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      const lines: string[] = [];
      for (const e of entries.slice(0, 1000)) {
        if (IGNORED_DIRS.has(e.name)) continue;
        lines.push(e.isDirectory() ? `${e.name}/` : e.name);
      }
      const t = truncate(lines.join('\n') || '(empty)');
      return { ok: true, output: t.text, truncated: t.truncated };
    },
  },
  {
    name: 'read_file',
    kind: 'read',
    description: 'Read a text file inside the project. Returns the content with line numbers.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the project root.' },
        offset: { type: 'number', description: '1-based line to start reading from.' },
        limit: { type: 'number', description: 'Maximum number of lines to read (default 400).' },
      },
      required: ['path'],
    },
    summarize: (args) => `read_file ${str(args, 'path') ?? ''}`,
    run: async (args, ctx) => {
      const abs = resolveInRoot(ctx.root, str(args, 'path'));
      const ext = path.extname(abs).toLowerCase();
      if (BINARY_EXT.has(ext)) {
        return { ok: false, error: `Refusing to read binary file: ${relPath(ctx.root, abs)}` };
      }
      const raw = fs.readFileSync(abs, 'utf8');
      const all = raw.split('\n');
      const offset = Math.max(1, num(args, 'offset') ?? 1);
      const limit = Math.min(2000, num(args, 'limit') ?? 400);
      const slice = all.slice(offset - 1, offset - 1 + limit);
      const numbered = slice.map((l, i) => `${String(offset + i).padStart(5)}  ${l}`).join('\n');
      const t = truncate(numbered.slice(0, MAX_FILE_READ));
      const note =
        offset - 1 + slice.length < all.length ? `\n… (${all.length - (offset - 1 + slice.length)} more lines)` : '';
      return { ok: true, output: t.text + note, truncated: t.truncated };
    },
  },
  {
    name: 'grep',
    kind: 'read',
    description: 'Search file contents with a regular expression across the project (skips node_modules, .git, build output).',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'JavaScript regular expression.' },
        path: { type: 'string', description: 'Optional subdirectory to search.' },
        glob: { type: 'string', description: 'Optional file extension filter, e.g. ".ts".' },
      },
      required: ['pattern'],
    },
    summarize: (args) => `grep ${str(args, 'pattern') ?? ''}`,
    run: async (args, ctx) => {
      const pattern = str(args, 'pattern');
      if (!pattern) return { ok: false, error: 'pattern is required' };
      let re: RegExp;
      try {
        re = new RegExp(pattern);
      } catch (e) {
        return { ok: false, error: `Invalid regex: ${(e as Error).message}` };
      }
      const ext = str(args, 'glob');
      const base = resolveInRoot(ctx.root, str(args, 'path'));
      const matches: string[] = [];
      const walk = (dir: string) => {
        if (matches.length >= 200) return;
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          if (matches.length >= 200) return;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) {
            if (!IGNORED_DIRS.has(e.name)) walk(full);
            continue;
          }
          if (e.isSymbolicLink()) continue;
          if (BINARY_EXT.has(path.extname(e.name).toLowerCase())) continue;
          if (ext && !e.name.endsWith(ext)) continue;
          let text: string;
          try {
            const st = fs.statSync(full);
            if (st.size > 1_000_000) continue;
            text = fs.readFileSync(full, 'utf8');
          } catch {
            continue;
          }
          const lines = text.split('\n');
          for (let i = 0; i < lines.length; i++) {
            try {
              if (re.test(lines[i])) {
                matches.push(`${relPath(ctx.root, full)}:${i + 1}: ${lines[i].trim().slice(0, 300)}`);
                if (matches.length >= 200) break;
              }
            } catch {
              break;
            }
          }
        }
      };
      walk(base);
      const t = truncate(matches.join('\n') || '(no matches)');
      return { ok: true, output: t.text, truncated: t.truncated };
    },
  },
  {
    name: 'write_file',
    kind: 'write',
    description: 'Create or overwrite a text file inside the project. Prefer edit_file for modifying existing files.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the project root.' },
        content: { type: 'string', description: 'Full new file content.' },
      },
      required: ['path', 'content'],
    },
    summarize: (args) => `write_file ${str(args, 'path') ?? ''}`,
    run: async (args, ctx) => {
      const p = str(args, 'path');
      const content = str(args, 'content');
      if (p === undefined || content === undefined) return { ok: false, error: 'path and content are required' };
      const abs = resolveInRoot(ctx.root, p);
      const oldText = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, 'utf8');
      return {
        ok: true,
        output: `${oldText === null ? 'Created' : 'Overwrote'} ${relPath(ctx.root, abs)} (${content.length} chars)`,
        diff: fileDiff(relPath(ctx.root, abs), oldText, content),
      };
    },
  },
  {
    name: 'edit_file',
    kind: 'write',
    description:
      'Replace an exact substring in an existing file. old_string must match exactly and (unless replace_all) occur exactly once. Include enough surrounding context to make it unique.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the project root.' },
        old_string: { type: 'string', description: 'Exact text to replace.' },
        new_string: { type: 'string', description: 'Replacement text.' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence (default false).' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    summarize: (args) => `edit_file ${str(args, 'path') ?? ''}`,
    run: async (args, ctx) => {
      const p = str(args, 'path');
      const oldStr = str(args, 'old_string');
      const newStr = str(args, 'new_string');
      if (p === undefined || oldStr === undefined || newStr === undefined) {
        return { ok: false, error: 'path, old_string and new_string are required' };
      }
      const abs = resolveInRoot(ctx.root, p);
      if (!fs.existsSync(abs)) return { ok: false, error: `File not found: ${relPath(ctx.root, abs)}` };
      const original = fs.readFileSync(abs, 'utf8');
      const occurrences = original.split(oldStr).length - 1;
      if (occurrences === 0) return { ok: false, error: 'old_string not found in file' };
      if (occurrences > 1 && !bool(args, 'replace_all')) {
        return { ok: false, error: `old_string occurs ${occurrences} times; provide more context or set replace_all` };
      }
      const updated = bool(args, 'replace_all')
        ? original.split(oldStr).join(newStr)
        : original.replace(oldStr, newStr);
      fs.writeFileSync(abs, updated, 'utf8');
      return {
        ok: true,
        output: `Edited ${relPath(ctx.root, abs)} (${occurrences} replacement${occurrences > 1 ? 's' : ''})`,
        diff: fileDiff(relPath(ctx.root, abs), original, updated),
      };
    },
  },
  {
    name: 'run_command',
    kind: 'exec',
    description:
      'Run a shell command in the project root (bash on macOS/Linux, cmd on Windows). Use for builds, tests, git, etc. Output is capped.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command line to run.' },
        timeout_ms: { type: 'number', description: 'Timeout in ms (default 120000, max 600000).' },
      },
      required: ['command'],
    },
    summarize: (args) => `run_command ${str(args, 'command') ?? ''}`.slice(0, 200),
    run: async (args, ctx) => {
      const command = str(args, 'command');
      if (!command) return { ok: false, error: 'command is required' };
      const timeout = Math.min(600_000, Math.max(1_000, num(args, 'timeout_ms') ?? 120_000));
      return new Promise<ToolResult>((resolve) => {
        exec(
          command,
          {
            cwd: ctx.root,
            timeout,
            maxBuffer: 10 * 1024 * 1024,
            env: { ...process.env, PI_DESKTOP: '1' },
            shell: process.platform === 'win32' ? undefined : '/bin/bash',
          },
          (err, stdout, stderr) => {
            const parts: string[] = [];
            if (stdout) parts.push(stdout.toString());
            if (stderr) parts.push(stderr.toString());
            const t = truncate(parts.join('\n').trim());
            if (err) {
              const code = (err as NodeJS.ErrnoException & { code?: number | string }).code;
              const timedOut = err.killed;
              resolve({
                ok: false,
                output: t.text || undefined,
                truncated: t.truncated,
                error: timedOut
                  ? `Command timed out after ${timeout}ms`
                  : `Command failed${code !== undefined ? ` (exit ${code})` : ''}`,
              });
            } else {
              resolve({ ok: true, output: t.text || '(no output)', truncated: t.truncated });
            }
          },
        );
      });
    },
  },
];

export function toolByName(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name);
}

export function toolSchemas(): ToolSchema[] {
  return TOOLS.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
}
