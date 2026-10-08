import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';

/**
 * Bundled office skills (pptx/docx/xlsx/pdf) shipped in app resources and
 * synced into <agentDir>/skills/ on startup so pi discovers them natively.
 * Managed-file semantics: a copy is refreshed on upgrade only while the user
 * has not edited it; once the on-disk hash differs from the recorded manifest
 * hash the directory is left untouched (and never re-synced until deleted).
 */
export const BUILTIN_MANIFEST_NAME = '.pi-desktop-builtin.json';

/** Deterministic content hash of every file in a skill directory (relative path keyed). */
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
function copyDir(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const rel of walk(src)) {
    const target = join(dest, rel);
    mkdirSync(target.slice(0, target.lastIndexOf('/')), { recursive: true });
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

export type BuiltinSkillSync = { synced: string[]; skipped: string[]; removed: string[] };

/** Sync bundled skills into the agent dir; returns what happened for logging. */
export function syncBuiltinSkills(agentDir: string, sourceDir: string): BuiltinSkillSync {
  const result: BuiltinSkillSync = { synced: [], skipped: [], removed: [] };
  if (!existsSync(sourceDir)) return result;
  const skillsDir = join(agentDir, 'skills');
  const manifestFile = join(skillsDir, BUILTIN_MANIFEST_NAME);
  const manifest = readManifest(manifestFile);

  const bundled = readdirSync(sourceDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && existsSync(join(sourceDir, e.name, 'SKILL.md')))
    .map(e => e.name);
  for (const name of bundled) {
    const source = join(sourceDir, name);
    let sourceHash: string;
    try { sourceHash = dirHash(source); } catch { result.skipped.push(name); continue; } // 单个坏目录不拖垮全局
    const target = join(skillsDir, name);
    try {
      if (existsSync(target)) {
        const currentHash = dirHash(target);
        // 无 manifest 记录 = 用户自建（非我们复制的），或已改动：均不覆盖。
        if (manifest[name] === undefined || currentHash !== manifest[name]) {
          // 但内容已与内置版一致（如中断拷贝后已完整落地）：只补记录即自愈。
          if (currentHash === sourceHash) { manifest[name] = sourceHash; result.synced.push(name); }
          else result.skipped.push(name);
          continue;
        }
        if (currentHash === sourceHash) continue; // already up to date
        rmSync(target, { recursive: true, force: true });
      }
      copyDir(source, target);
      manifest[name] = sourceHash;
      result.synced.push(name);
    } catch { result.skipped.push(name); }
  }

  // Bundled skills removed from this build: clean up only untouched copies.
  for (const [name, recorded] of Object.entries(manifest)) {
    if (bundled.includes(name)) continue;
    const target = join(skillsDir, name);
    if (existsSync(target)) {
      try {
        if (statSync(target).isDirectory() && dirHash(target) === recorded) {
          rmSync(target, { recursive: true, force: true });
          delete manifest[name];
          result.removed.push(name);
          continue;
        }
      } catch { /* unreadable dir — leave it alone */ }
    }
    delete manifest[name];
  }

  mkdirSync(skillsDir, { recursive: true });
  const serialized = JSON.stringify(manifest, null, 2) + '\n';
  if (!existsSync(manifestFile) || readFileSync(manifestFile, 'utf8') !== serialized) writeFileSync(manifestFile, serialized);
  return result;
}
