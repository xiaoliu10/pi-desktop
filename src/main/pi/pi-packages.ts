/**
 * pi package management: the "marketplace" for pi extensions is the npm
 * ecosystem (packages tagged `pi-package`), installed with the official
 * `pi install <source>` CLI — pi itself handles dependency download,
 * scripts allowlist and settings registration. Desktop only orchestrates:
 * search (npm registry), install/remove (spawn pi), and register/unregister
 * (edit settings.packages for packages that were copied in without it).
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { PiInstalledPackage, PiMarketPackage } from '../../shared/pi';
const exec = promisify(execFile);

const REGISTRY = 'https://registry.npmjs.org/-/v1/search';

const SOURCE_RE = /^(npm:[A-Za-z0-9@/_-]+(@[^/\s]+)?|git:[^\s]+|https:\/\/[^\s]+|ssh:\/\/[^\s]+)$/;

export function isValidSource(source: string): boolean {
  return typeof source === 'string' && source.length <= 300 && SOURCE_RE.test(source);
}

function readSettings(root: string): Record<string, any> {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8')) ?? {}; } catch { return {}; }
}

function registeredSpecs(settings: Record<string, any>): string[] {
  return (Array.isArray(settings.packages) ? settings.packages : [])
    .map((raw: unknown) => (typeof raw === 'string' ? raw : typeof raw === 'object' && raw ? String((raw as any).source ?? '') : ''))
    .filter(Boolean);
}

function manifestKinds(dir: string): string[] {
  try {
    const pi = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))?.pi;
    if (!pi || typeof pi !== 'object') return [];
    return ['extensions', 'skills', 'prompts', 'themes'].filter((k) => Array.isArray(pi[k]) ? pi[k].length : typeof pi[k] === 'string');
  } catch { return []; }
}

function readPackage(dir: string): { name: string; version: string; description: string } | null {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    if (typeof manifest?.name !== 'string' || !manifest.name) return null;
    return { name: manifest.name, version: String(manifest.version ?? ''), description: String(manifest.description ?? '') };
  } catch { return null; }
}

/** Top-level package names declared by the agent npm root (transitive deps excluded). */
function topLevelNames(agentDir: string): Set<string> | null {
  try {
    const deps = JSON.parse(fs.readFileSync(path.join(agentDir, 'npm', 'package.json'), 'utf8'))?.dependencies;
    if (deps && typeof deps === 'object') return new Set(Object.keys(deps));
  } catch { /* optional */ }
  return null;
}

/** Normalize an npm spec from settings ("npm:name", objects, ranges) to a bare name for matching. */
function specToName(spec: string): string {
  return spec.replace(/^npm:/, '').replace(/@[^/@]+$/, '') || spec;
}

export async function listInstalledPackages(agentDir: string): Promise<PiInstalledPackage[]> {
  const settings = readSettings(agentDir);
  const registered = new Set(registeredSpecs(settings));
  const out = new Map<string, PiInstalledPackage>();
  const push = (item: PiInstalledPackage) => out.set(item.path, item);
  // 1) Packages registered in settings.packages (the sources pi actually loads).
  for (const spec of registered) {
    const name = specToName(spec);
    const dir = spec.startsWith('npm:')
      ? path.join(agentDir, 'npm', 'node_modules', name)
      : /^(git:|https?:|ssh:)/.test(spec)
        ? path.join(agentDir, 'git', name.replace(/^https?:\/\//, '').replace(/^git@/, '').replace(/:/, '/').replace(/\.git$/, ''))
        : path.resolve(agentDir, spec);
    const meta = fs.existsSync(dir) ? readPackage(dir) : null;
    push({ name: meta?.name ?? name, spec, version: meta?.version ?? '', description: meta?.description ?? '', registered: true, kinds: fs.existsSync(dir) ? manifestKinds(dir) : [], path: dir, enabled: true });
  }
  // 2) Packages physically present in the npm root — installed but possibly
  //    not registered (pi would not load those). Only top-level dependencies;
  //    transitive deps in node_modules are not extensions.
  const npmRoot = path.join(agentDir, 'npm', 'node_modules');
  for (const name of topLevelNames(agentDir) ?? []) {
    const dir = path.join(npmRoot, name);
    if ([...out.values()].some((p) => p.path === dir)) continue;
    const meta = readPackage(dir);
    if (!meta) continue;
    const spec = `npm:${meta.name}`;
    push({ name: meta.name, spec, version: meta.version, description: meta.description, registered: registered.has(spec), kinds: manifestKinds(dir), path: dir });
  }
  return [...out.values()].sort((a, b) => Number(b.registered) - Number(a.registered) || a.name.localeCompare(b.name));
}

interface NpmSearchObject { package?: { name?: string; version?: string; description?: string; keywords?: string[]; publisher?: { username?: string }; author?: { name?: string }; links?: { npm?: string } }; searchScore?: number }

export async function searchMarket(query: string, fetchJson: typeof fetch = fetch): Promise<PiMarketPackage[]> {
  // Empty query → browse the curated ecosystem keyword; free text → npm full search.
  const text = query.trim() ? `${query.trim()} keywords:pi-package` : 'keywords:pi-package';
  const url = `${REGISTRY}?text=${encodeURIComponent(text)}&size=36`;
  const res = await fetchJson(url, { headers: { accept: 'application/json' } } as RequestInit);
  if (!res.ok) throw new Error(`npm 搜索失败：HTTP ${res.status}`);
  const data = await res.json() as { objects?: NpmSearchObject[] };
  return (data.objects ?? [])
    .map((o) => o.package ?? {})
    .filter((p) => typeof p.name === 'string' && p.name && !p.name.startsWith('pi-coding-agent'))
    .map((p) => ({
      name: p.name!,
      version: String(p.version ?? ''),
      description: String(p.description ?? ''),
      publisher: String(p.publisher?.username ?? p.author?.name ?? p.name!.split('/')[0].replace(/^@/, '')),
      keywords: Array.isArray(p.keywords) ? p.keywords.slice(0, 6) : [],
      link: typeof p.links?.npm === 'string' ? p.links.npm : `https://www.npmjs.com/package/${p.name}`,
    }));
}

// -- covers -------------------------------------------------------------------
// 市场卡片的封面缩略图：README 首张非徽章图片。npm 搜索接口不带 README，
// 这里按包解析（registry /latest 拿仓库信息，jsdelivr/unpkg 拿 README.md），
// 并把结果展开成候选 URL 链：GitHub raw 在国内直连不稳定，jsdelivr 镜像优先。

const NPM_NAME_RE = /^(@[a-z0-9-][a-z0-9._-]*\/)?[a-z0-9-][a-z0-9._-]*$/i;
const BADGE_RE = /img\.shields\.io|badgen\.net|badge\/|nodei\.co|travis-ci|circleci|codecov\.io|coveralls\.io|api\.star-history\.com/i;
const COVER_TTL_MS = 24 * 60 * 60 * 1000;
const coverCache = new Map<string, { covers: string[]; at: number }>();

/** First cover-worthy image URL in a README (inline → html img → reference style). */
export function extractCoverImage(readme: string): string | null {
  const text = readme.slice(0, 250_000);
  const refs = new Map<string, string>();
  for (const m of text.matchAll(/^\s*\[([^\]]+)\]:\s*(\S+)\s*$/gm)) refs.set(m[1].toLowerCase(), m[2]);
  const pick = (raw: string | undefined): string | null => {
    const url = raw?.trim();
    if (!url || /^data:/i.test(url) || BADGE_RE.test(url)) return null;
    return url;
  };
  for (const m of text.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?/g)) { const u = pick(m[1]); if (u) return u; }
  for (const m of text.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi)) { const u = pick(m[1]); if (u) return u; }
  for (const m of text.matchAll(/!\[[^\]]*\]\[([^\]]+)\]/g)) { const u = pick(refs.get(m[1].toLowerCase())); if (u) return u; }
  return null;
}

function repoSlug(repo: unknown, homepage: unknown): { slug: string; dir: string } | null {
  const raw = typeof repo === 'string' ? repo : typeof (repo as { url?: unknown } | null)?.url === 'string' ? (repo as { url: string }).url : '';
  const dir = typeof (repo as { directory?: unknown } | null)?.directory === 'string' ? String((repo as { directory: string }).directory).replace(/^\/|\/$/g, '') : '';
  const m = raw.match(/github\.com[/:]([^/]+)\/([^/#]+?)(?:\.git)?\/?$/i);
  if (m) return { slug: `${m[1]}/${m[2]}`, dir };
  const h = typeof homepage === 'string' ? homepage.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)/i) : null;
  return h ? { slug: `${h[1]}/${h[2]}`, dir } : null;
}

/** Expand one README image URL into candidate <img> sources, mirrors first. */
export function coverCandidates(name: string, version: string, image: string, repo: { slug: string; dir: string } | null): string[] {
  const out: string[] = [];
  const push = (u: string | undefined) => { if (u && u.startsWith('https://') && !out.includes(u)) out.push(u); };
  if (/^https?:\/\//i.test(image)) {
    const url = image.replace(/^http:\/\//i, 'https://');
    let m = url.match(/^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/);
    if (m) { push(`https://cdn.jsdelivr.net/gh/${m[1]}/${m[2]}@${m[3]}/${m[4]}`); push(url); push(`https://gh-proxy.com/${url}`); return out; }
    m = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:raw|blob)\/([^/]+)\/(.+)$/);
    if (m) { push(`https://cdn.jsdelivr.net/gh/${m[1]}/${m[2]}@${m[3]}/${m[4]}`); push(`https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}/${m[4]}`); return out; }
    if (/^https:\/\/github\.com\/[^/]+\/[^/]+\/(releases\/download|user-attachments)\//.test(url)) { push(url); push(`https://gh-proxy.com/${url}`); return out; }
    push(url);
    return out;
  }
  const rel = image.replace(/^\.?\//, '');
  if (!rel || rel.includes('..') || rel.includes('\\')) return [];
  push(`https://cdn.jsdelivr.net/npm/${name}@${version}/${rel}`);
  push(`https://unpkg.com/${name}@${version}/${rel}`);
  if (repo) {
    const inRepo = `${repo.dir ? `${repo.dir}/` : ''}${rel}`;
    push(`https://cdn.jsdelivr.net/gh/${repo.slug}@main/${inRepo}`);
    push(`https://cdn.jsdelivr.net/gh/${repo.slug}@master/${inRepo}`);
    push(`https://raw.githubusercontent.com/${repo.slug}/HEAD/${inRepo}`);
    push(`https://gh-proxy.com/https://raw.githubusercontent.com/${repo.slug}/HEAD/${inRepo}`);
  }
  return out;
}

async function fetchText(url: string, fetchImpl: typeof fetch): Promise<string | null> {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } } as RequestInit);
    return res.ok ? await res.text() : null;
  } catch { return null; }
}

async function resolvePackageCover(name: string, fetchImpl: typeof fetch): Promise<string[]> {
  let manifest: { version?: unknown; repository?: unknown; homepage?: unknown } | null = null;
  try {
    const raw = await fetchText(`https://registry.npmjs.org/${name}/latest`, fetchImpl);
    if (raw) manifest = JSON.parse(raw);
  } catch { /* optional */ }
  // npm 会把 README 注入发布包，jsdelivr/unpkg 直接按路径取即可。
  const readme = (await fetchText(`https://cdn.jsdelivr.net/npm/${name}/README.md`, fetchImpl))
    ?? (await fetchText(`https://unpkg.com/${name}/README.md`, fetchImpl));
  const image = readme ? extractCoverImage(readme) : null;
  if (!image) return [];
  return coverCandidates(name, String(manifest?.version ?? 'latest'), image, repoSlug(manifest?.repository, manifest?.homepage));
}

/** Cover candidate URLs for a batch of packages; results are cached for a day. */
export async function packageCovers(names: readonly string[], fetchImpl: typeof fetch = fetch): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  const pending: string[] = [];
  const now = Date.now();
  for (const name of names) {
    if (typeof name !== 'string' || name.length > 214 || !NPM_NAME_RE.test(name)) continue;
    const hit = coverCache.get(name);
    if (hit && now - hit.at < COVER_TTL_MS) out[name] = hit.covers;
    else if (!pending.includes(name)) pending.push(name);
  }
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(6, pending.length) }, async () => {
    while (cursor < pending.length) {
      const name = pending[cursor++];
      const covers = await resolvePackageCover(name, fetchImpl).catch(() => [] as string[]);
      coverCache.set(name, { covers, at: Date.now() });
      out[name] = covers;
    }
  }));
  return out;
}

/** Run `pi install <source>` (user scope). pi writes settings.packages itself. */
export async function installPackage(piExecutable: string, source: string, cwd: string, action: 'install' | 'remove' = 'install'): Promise<string> {
  if (!isValidSource(source)) throw new Error('包来源格式无效（支持 npm:name / git:url / https://…）');
  const { stdout, stderr } = await exec(piExecutable, [action, source], { cwd, timeout: 300_000, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return `${stdout}\n${stderr}`.trim().slice(-2000);
}

/** Register an already-present package in settings.packages without reinstalling. */
export async function registerPackage(agentDir: string, spec: string): Promise<void> {
  if (!isValidSource(spec)) throw new Error('包来源格式无效');
  const file = path.join(agentDir, 'settings.json');
  const settings = readSettings(agentDir);
  const packages = registeredSpecs(settings);
  if (packages.includes(spec)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const next = { ...settings, packages: [...packages, spec] };
  fs.writeFileSync(file + '.tmp', JSON.stringify(next, null, 2) + '\n', 'utf8');
  fs.renameSync(file + '.tmp', file);
}
