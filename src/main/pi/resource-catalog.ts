import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { PiCommand, PiResource } from '../../shared/pi';
const kinds = ['extensions', 'skills', 'prompts', 'themes'] as const;
const exists = (p: string) => fs.existsSync(p);
function walk(root: string, depth = 0): string[] {
  if (depth > 5) return [];
  try { return fs.readdirSync(root, { withFileTypes: true }).flatMap(e => {
    if (e.name === 'node_modules' || e.name.startsWith('.')) return [];
    const p = path.join(root, e.name);
    return e.isDirectory() ? [p, ...walk(p, depth + 1)] : e.isFile() ? [p] : [];
  }); } catch { return []; }
}
function matches(pattern: string, text: string): boolean {
  const regex = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\0').replace(/\*/g, '[^/]*').replace(/\0/g, '.*').replace(/\?/g, '[^/]');
  return new RegExp('^' + regex + '$').test(text.replaceAll(path.sep, '/'));
}
/** Static catalog: never imports or executes extension code. Runtime evidence is separate. */
export function resourceCatalog(agentDir: string, cwd?: string, commands: PiCommand[] = [], sharedSkillsDir = path.join(os.homedir(), '.agents/skills')): PiResource[] {
  const out = new Map<string, PiResource>();
  const add = (p: string, kind: string, scope: 'user' | 'project', detail: string, disabled = false) => {
    const id = `${scope}:${kind}:${p}`;
    const callable = commands.some(c => c.path === p || (c.path && c.path.startsWith(p + path.sep)));
    out.set(id, { id, path: p, name: path.basename(p), kind, scope, status: disabled ? 'disabled' : !exists(p) ? 'missing' : callable ? 'callable' : 'discovered', detail: `${detail}。${callable ? '当前 RPC 已注册命令' : '静态发现，当前运行时加载未确认'}${scope === 'project' ? '；受项目信任策略限制' : ''}。自定义 TUI 需单独适配。` });
  };
  const loadManifest = (dir: string, scope: 'user' | 'project', source: string, filter?: Record<string, any>) => {
    let pi: any = {};
    try { pi = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).pi || {}; } catch { if (exists(path.join(dir, 'package.json'))) { const id = `${scope}:manifest:${dir}`; out.set(id, { id, name: 'package.json', path: path.join(dir, 'package.json'), kind: 'config', scope, status: 'error', detail: '包 manifest 无法解析，仅展示约定目录；加载状态未知。' }); } }
    for (const kind of kinds) {
      const patterns = Array.isArray(pi[kind]) ? pi[kind] : [kind];
      const selected = new Set<string>();
      for (const pattern of patterns.filter((x: unknown) => typeof x === 'string')) {
        const excluded = pattern.startsWith('!'), rel = excluded ? pattern.slice(1) : pattern;
        const full = path.resolve(dir, rel);
        const found = /[*?]/.test(rel) ? walk(dir).filter(p => matches(rel.replace(/^\.\//, ''), path.relative(dir, p))) : [full];
        for (const p of found) { if (excluded) selected.delete(p); else if (exists(p)) selected.add(p); }
      }
      for (const p of selected) {
        const rules = filter?.[kind];
        const disabled = Array.isArray(rules) && (!rules.length || !rules.some((r: unknown) => typeof r === 'string' && !r.startsWith('!') && matches(r.replace(/^\.\//, ''), path.relative(dir, p))));
        add(p, kind, scope, source + (filter ? '；包过滤规则请以 pi 实际加载为准' : ''), disabled);
      }
    }
  };
  for (const { root, scope } of [{ root: agentDir, scope: 'user' as const }, ...(cwd ? [{ root: path.join(cwd, '.pi'), scope: 'project' as const }] : [])]) {
    let settings: Record<string, any> = {};
    try { settings = JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8')); if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('配置必须为对象'); }
    catch (err) { settings = {}; if (exists(path.join(root, 'settings.json'))) out.set(root, { id: root, name: 'settings.json', kind: 'config', path: root, scope, status: 'error', detail: '配置无法解析，未执行或改写。' }); }
    for (const kind of kinds) {
      const dir = path.join(root, kind);
      try { for (const e of fs.readdirSync(dir)) if (!e.startsWith('.')) add(path.join(dir, e), kind, scope, 'pi 原生资源目录'); } catch { /* optional */ }
      for (const spec of Array.isArray(settings[kind]) ? settings[kind] : []) if (typeof spec === 'string') {
        const disabled = spec.startsWith('!') || spec.startsWith('-'), rel = /^[!+-]/.test(spec) ? spec.slice(1) : spec;
        const p = rel.startsWith('~/') ? path.join(os.homedir(), rel.slice(2)) : path.resolve(root, rel);
        if (/[*?]/.test(rel)) {
          for (const match of walk(root).filter(x => matches(p, x))) add(match, kind, scope, '配置路径模式', disabled);
        } else add(p, kind, scope, '配置显式路径', disabled);
      }
    }
    for (const raw of Array.isArray(settings.packages) ? settings.packages : []) {
      const spec = typeof raw === 'string' ? raw : raw && typeof raw === 'object' && 'source' in raw ? raw.source : undefined;
      if (typeof spec !== 'string') continue;
      let dir: string;
      if (spec.startsWith('npm:')) {
        const pkg = spec.slice(4).replace(/@[^/]*$/, '');
        dir = path.join(root, 'npm/node_modules', pkg);
      } else if (/^(git:|https?:|ssh:)/.test(spec)) {
        const rel = spec.replace(/^git:/, '').replace(/^(https?:\/\/|ssh:\/\/|git@)/, '').replace(':', '/').replace(/@[^/]+$/, '').replace(/\.git$/, '');
        dir = path.join(root, 'git', rel);
      } else dir = spec.startsWith('~/') ? path.join(os.homedir(), spec.slice(2)) : path.resolve(root, spec);
      add(dir, 'package', scope, spec);
      if (exists(dir)) { if (fs.statSync(dir).isDirectory()) loadManifest(dir, scope, spec, typeof raw === 'object' ? raw : undefined); else add(dir, 'extensions', scope, spec); }
    }
    // Packages downloaded into the npm root but not registered in
    // settings.packages: pi does not load them; surface with that caveat.
    // Only the npm root's own dependencies count — node_modules transitive
    // deps of those packages are not extensions.
    let topLevel: string[] = [];
    try { topLevel = Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'npm', 'package.json'), 'utf8'))?.dependencies ?? {}); } catch { /* optional */ }
    for (const name of topLevel) {
      const dir = path.join(root, 'npm', 'node_modules', name);
      let manifest: any;
      try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { continue; }
      if (typeof manifest?.name !== 'string') continue;
      const spec = `npm:${manifest.name}`;
      const registered = (Array.isArray(settings.packages) ? settings.packages : []).some((raw: unknown) => (typeof raw === 'string' ? raw : raw && typeof raw === 'object' && 'source' in raw ? raw.source : undefined) === spec);
      if (registered) continue;
      add(dir, 'package', scope, `${spec}（已下载未注册，pi 不会加载；可在扩展页一键注册）`, true);
    }
  }
  // Shared skill roots recognized by pi (metadata only, no evaluation).
  const sharedRoots: Array<{dir:string;scope:'user'|'project'}> = [];
  sharedRoots.push({dir:sharedSkillsDir,scope:'user'});
  if (cwd) { let dir=path.resolve(cwd); for (;;) { sharedRoots.push({dir:path.join(dir,'.agents/skills'),scope:'project'}); if(exists(path.join(dir,'.git'))||path.dirname(dir)===dir)break;dir=path.dirname(dir); } }
  for (const {dir,scope} of sharedRoots) for (const file of walk(dir)) {
    if(!file.endsWith('.md')||!fs.statSync(file).isFile())continue;
    if(path.basename(file)==='SKILL.md')add(file,'skills',scope,'共享 .agents 技能目录');
    else if(path.dirname(file)!==dir)try{if(fs.statSync(file).size<512*1024&&/^---\r?\n[\s\S]*?^description:\s*\S/m.test(fs.readFileSync(file,'utf8')))add(file,'skills',scope,'共享 .agents 技能目录');}catch{}
  }
  // Commands can originate from sources that the static catalog cannot resolve.
  for (const command of commands) if (command.path) add(command.path, command.source || 'command', cwd && command.path.startsWith(cwd + path.sep) ? 'project' : 'user', `/${command.name}`);
  for(const {root,scope} of [{root:agentDir,scope:'user'},...(cwd?[{root:path.join(cwd,'.pi'),scope:'project'}]:[])]) {
    let cfg:any;try{cfg=JSON.parse(fs.readFileSync(path.join(root,'settings.json'),'utf8'));}catch{continue;}
    for(const kind of kinds)for(const spec of Array.isArray(cfg?.[kind])?cfg[kind]:[]) {
      if(typeof spec!=='string'||!spec.startsWith('-'))continue;
      const target=path.resolve(root,spec.slice(1));for(const r of out.values())if(r.scope===scope&&r.kind===kind&&(r.path===target||r.path.startsWith(target+path.sep)))r.status='disabled';
    }
  }
  return [...out.values()];
}
