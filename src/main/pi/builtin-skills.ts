import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

/**
 * Bundled resources (office skills, prompt templates) shipped in app resources
 * and synced into the agent dir on startup so pi discovers them natively.
 * Managed-file semantics: a copy is refreshed on upgrade only while the user
 * has not edited it; once the on-disk hash differs from the recorded manifest
 * hash the entry is left untouched (and never re-synced until deleted).
 */
export const BUILTIN_MANIFEST_NAME = '.pi-desktop-builtin.json';
export const BUILTIN_PROMPTS_MANIFEST_NAME = '.pi-desktop-builtin-prompts.json';

/** Deterministic content hash of every file in a directory (relative path keyed). */
function dirHash(dir: string): string {
  const hash = createHash('sha1');
  for (const rel of walk(dir).sort()) {
    hash.update(rel);
    hash.update('\0');
    hash.update(readFileSync(join(dir, rel)));
    hash.update('\0');
  }
  return hash.digest('hex');
}
function walk(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}
function entryHash(source: string, isDir: boolean): string {
  if (!isDir) return createHash('sha1').update(readFileSync(source)).digest('hex');
  return dirHash(source);
}
function copyEntry(src: string, dest: string, isDir: boolean): void {
  if (!isDir) { mkdirSync(dirname(dest), { recursive: true }); writeFileSync(dest, readFileSync(src)); return; }
  mkdirSync(dest, { recursive: true });
  for (const rel of walk(src)) {
    const target = join(dest, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(join(src, rel)));
  }
}

type Manifest = Record<string, string>;
function readManifest(file: string): Manifest {
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc as Manifest : {};
  } catch { return {}; }
}

export type BuiltinSync = { synced: string[]; skipped: string[]; removed: string[] };

/**
 * Managed copy of bundled entries (skills = directories, prompts = .md files)
 * into targetDir, keyed by manifestFile. Shared state machine:
 * missing → copy · untouched → upgrade · user-edited/user-created → skip ·
 * interrupted copy (content already current) → heal by recording ·
 * removed from build → clean up untouched copies · one bad entry never
 * poisons the rest.
 * Limitation: if a bundled entry ever changes shape (dir ↔ file), an existing
 * old-shape copy is treated as the user's and skipped forever (stale copy
 * lingers); delete it manually to re-sync.
 */
function managedSync(targetDir: string, sourceDir: string, manifestFile: string, bundled: { name: string; dir: boolean }[]): BuiltinSync {
  const result: BuiltinSync = { synced: [], skipped: [], removed: [] };
  const manifest = readManifest(manifestFile);
  for (const { name, dir: isDir } of bundled) {
    const source = join(sourceDir, name);
    let sourceHash: string;
    try { sourceHash = entryHash(source, isDir); } catch { result.skipped.push(name); continue; } // 单个坏条目不拖垮全局
    const target = join(targetDir, name);
    try {
      if (existsSync(target)) {
        const targetIsDir = statSync(target).isDirectory();
        const currentHash = targetIsDir === isDir ? entryHash(target, isDir) : undefined; // 形态不符（同名文件/目录）= 用户之物
        // 无 manifest 记录 = 用户自建（非我们复制的），或已改动：均不覆盖。
        if (currentHash === undefined || manifest[name] === undefined || currentHash !== manifest[name]) {
          // 但内容已与内置版一致（如中断拷贝后已完整落地）：只补记录即自愈。
          if (currentHash === sourceHash) { manifest[name] = sourceHash; result.synced.push(name); }
          else result.skipped.push(name);
          continue;
        }
        if (currentHash === sourceHash) continue; // already up to date
        rmSync(target, { recursive: true, force: true });
      }
      copyEntry(source, target, isDir);
      manifest[name] = sourceHash;
      result.synced.push(name);
    } catch { result.skipped.push(name); }
  }

  // Entries removed from this build: clean up only untouched copies.
  // Manifest keys come from our own writes; reject anything path-like (defense
  // against a hand-edited manifest deleting outside targetDir).
  for (const [name, recorded] of Object.entries(manifest)) {
    if (name.includes('/') || name.includes('\\') || name === '..' || name.includes('\0')) { delete manifest[name]; continue; }
    if (bundled.some(b => b.name === name)) continue;
    const target = join(targetDir, name);
    if (existsSync(target)) {
      try {
        const isDir = statSync(target).isDirectory();
        if (entryHash(target, isDir) === recorded) {
          rmSync(target, { recursive: true, force: true });
          delete manifest[name];
          result.removed.push(name);
          continue;
        }
      } catch { /* unreadable entry — leave it alone */ }
    }
    delete manifest[name];
  }

  mkdirSync(targetDir, { recursive: true });
  const serialized = JSON.stringify(manifest, null, 2) + '\n';
  if (!existsSync(manifestFile) || readFileSync(manifestFile, 'utf8') !== serialized) writeFileSync(manifestFile, serialized);
  return result;
}

/** Sync bundled office skills into <agentDir>/skills/. */
export function syncBuiltinSkills(agentDir: string, sourceDir: string): BuiltinSync {
  if (!existsSync(sourceDir)) return { synced: [], skipped: [], removed: [] };
  const skillsDir = join(agentDir, 'skills');
  const bundled = readdirSync(sourceDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && existsSync(join(sourceDir, e.name, 'SKILL.md')))
    .map(e => ({ name: e.name, dir: true }));
  return managedSync(skillsDir, sourceDir, join(skillsDir, BUILTIN_MANIFEST_NAME), bundled);
}

/**
 * Sync bundled prompt templates into <agentDir>/prompts/ — pi turns each .md
 * into a slash command (/filename), the native equivalent of ZCode's preset
 * prompt cards (weekly report, failure triage, …).
 */
export function syncBuiltinPrompts(agentDir: string, sourceDir: string): BuiltinSync {
  if (!existsSync(sourceDir)) return { synced: [], skipped: [], removed: [] };
  const promptsDir = join(agentDir, 'prompts');
  const bundled = readdirSync(sourceDir, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('.'))
    .map(e => ({ name: e.name, dir: false }));
  return managedSync(promptsDir, sourceDir, join(promptsDir, BUILTIN_PROMPTS_MANIFEST_NAME), bundled);
}
