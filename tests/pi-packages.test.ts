import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listInstalledPackages, registerPackage, searchMarket, isValidSource, packageCovers, extractCoverImage, coverCandidates } from '../src/main/pi/pi-packages';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((p) => fs.rmSync(p, { recursive: true, force: true })));

function npmPkg(agentDir: string, name: string, version = '1.0.0', pi?: Record<string, unknown>) {
  const dir = path.join(agentDir, 'npm', 'node_modules', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version, description: `${name} 描述`, pi }));
  // 只有 npm 根 package.json 的 dependencies 才算顶层安装包
  const rootManifest = path.join(agentDir, 'npm', 'package.json');
  const deps = JSON.parse(fs.readFileSync(rootManifest, 'utf8'));
  deps.dependencies[name] = `^${version}`;
  fs.writeFileSync(rootManifest, JSON.stringify(deps, null, 2));
  return dir;
}

function agentDir(packages: unknown[] = []): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-pkg-'));
  roots.push(root);
  fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ packages }));
  fs.mkdirSync(path.join(root, 'npm'), { recursive: true });
  fs.writeFileSync(path.join(root, 'npm', 'package.json'), JSON.stringify({ name: 'pi-extensions', dependencies: {} }));
  return root;
}

describe('listInstalledPackages', () => {
  it('lists registered settings packages and unregistered npm packages on disk', async () => {
    const dir = agentDir(['npm:pi-memory']);
    npmPkg(dir, 'pi-memory', '0.4.2', { extensions: ['index.ts'] });
    npmPkg(dir, 'pi-web-access', '0.30.0', { extensions: ['index.ts'], skills: ['skills'] });
    // 传递依赖不应出现
    const dep = path.join(dir, 'npm', 'node_modules', 'transitive-dep');
    fs.mkdirSync(dep, { recursive: true });
    fs.writeFileSync(path.join(dep, 'package.json'), JSON.stringify({ name: 'transitive-dep', version: '0.0.1' }));
    const list = await listInstalledPackages(dir);
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ name: 'pi-memory', registered: true, version: '0.4.2' });
    expect(list[1]).toMatchObject({ name: 'pi-web-access', registered: false });
    expect(list[1].kinds).toEqual(expect.arrayContaining(['extensions', 'skills']));
  });

  it('handles scoped packages and missing settings file', async () => {
    const dir = agentDir();
    fs.rmSync(path.join(dir, 'settings.json'));
    npmPkg(dir, '@scope/pi-tool');
    const list = await listInstalledPackages(dir);
    expect(list).toEqual([expect.objectContaining({ name: '@scope/pi-tool', registered: false, spec: 'npm:@scope/pi-tool' })]);
  });
});

describe('registerPackage', () => {
  it('appends to settings.packages atomically and is idempotent', async () => {
    const dir = agentDir(['npm:pi-memory']);
    await registerPackage(dir, 'npm:pi-web-access');
    const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    expect(settings.packages).toEqual(['npm:pi-memory', 'npm:pi-web-access']);
    await registerPackage(dir, 'npm:pi-web-access');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).packages).toHaveLength(2);
  });

  it('rejects invalid sources', async () => {
    const dir = agentDir();
    await expect(registerPackage(dir, 'npm:x; rm -rf /')).rejects.toThrow('无效');
  });
});

describe('searchMarket', () => {
  it('maps npm registry results to market packages', async () => {
    const fakeFetch = (async (url: any) => ({
      ok: true,
      json: async () => ({ objects: [{ package: { name: 'pi-demo', version: '1.2.0', description: 'Demo', publisher: { username: 'alice' }, keywords: ['pi-package', 'demo'], links: { npm: 'https://npmjs.com/package/pi-demo' } } }] }),
    })) as any;
    const market = await searchMarket('demo', fakeFetch);
    expect(market).toEqual([expect.objectContaining({ name: 'pi-demo', version: '1.2.0', publisher: 'alice' })]);
  });

  it('throws on registry errors', async () => {
    const fakeFetch = (async () => ({ ok: false, status: 503, json: async () => ({}) })) as any;
    await expect(searchMarket('x', fakeFetch)).rejects.toThrow('503');
  });
});

describe('isValidSource', () => {
  it('accepts npm/git/http sources and rejects shell tricks', () => {
    expect(isValidSource('npm:pi-memory')).toBe(true);
    expect(isValidSource('npm:@scope/pkg@1.2.3')).toBe(true);
    expect(isValidSource('https://github.com/a/b.git')).toBe(true);
    expect(isValidSource('npm:x; echo pwn')).toBe(false);
    expect(isValidSource('$(whoami)')).toBe(false);
  });
});

describe('packageCovers', () => {
  /** fetch stub：按 URL 正则返回预设响应，并记录调用序列。 */
  function fetchScript(responses: Array<{ match: RegExp; body: string }>) {
    const calls: string[] = [];
    const impl = (async (input: any) => {
      const url = String(input);
      calls.push(url);
      const hit = responses.find((r) => r.match.test(url));
      return new Response(hit ? hit.body : 'not found', { status: hit ? 200 : 404 });
    }) as any;
    return { impl, calls };
  }

  it('extracts the first non-badge image and expands mirror candidates', async () => {
    const { impl, calls } = fetchScript([
      { match: /registry\.npmjs\.org\/pi-demo\/latest/, body: JSON.stringify({ version: '1.2.0', repository: { url: 'git+https://github.com/o/pi-demo.git' } }) },
      { match: /README\.md/, body: '# pi-demo\n\n![badge](https://img.shields.io/npm/v/pi-demo)\n\n![banner](banner.png)\n' },
    ]);
    const covers = await packageCovers(['pi-demo'], impl);
    expect(covers['pi-demo']).toEqual([
      'https://cdn.jsdelivr.net/npm/pi-demo@1.2.0/banner.png',
      'https://unpkg.com/pi-demo@1.2.0/banner.png',
      'https://cdn.jsdelivr.net/gh/o/pi-demo@main/banner.png',
      'https://cdn.jsdelivr.net/gh/o/pi-demo@master/banner.png',
      'https://raw.githubusercontent.com/o/pi-demo/HEAD/banner.png',
      'https://gh-proxy.com/https://raw.githubusercontent.com/o/pi-demo/HEAD/banner.png',
    ]);
    // manifest + jsdelivr README，unpkg 不再需要
    expect(calls.filter((u) => u.includes('unpkg'))).toEqual([]);
  });

  it('rewrites raw.githubusercontent covers to the jsdelivr mirror first', async () => {
    const { impl } = fetchScript([
      { match: /registry\.npmjs\.org\/pi-raw\/latest/, body: JSON.stringify({ version: '0.1.0' }) },
      { match: /README\.md/, body: '![cover](https://raw.githubusercontent.com/o/r/main/docs/cover.png)\n' },
    ]);
    const covers = await packageCovers(['pi-raw'], impl);
    expect(covers['pi-raw']?.[0]).toBe('https://cdn.jsdelivr.net/gh/o/r@main/docs/cover.png');
    expect(covers['pi-raw']).toContain('https://raw.githubusercontent.com/o/r/main/docs/cover.png');
  });

  it('negative-caches badge-only readmes and repeats nothing on second call', async () => {
    const { impl, calls } = fetchScript([
      { match: /registry\.npmjs\.org\/pi-badges\/latest/, body: JSON.stringify({ version: '1.0.0' }) },
      { match: /README\.md/, body: '![v](https://img.shields.io/npm/v/pi-badges) ![b](https://img.shields.io/badge/x-y)\n' },
    ]);
    const first = await packageCovers(['pi-badges'], impl);
    expect(first['pi-badges']).toEqual([]);
    const after = calls.length;
    const second = await packageCovers(['pi-badges'], impl);
    expect(second['pi-badges']).toEqual([]);
    expect(calls.length).toBe(after);
  });

  it('skips invalid names instead of building URLs from them', async () => {
    const { impl, calls } = fetchScript([]);
    const covers = await packageCovers(['../evil', 'x; rm -rf /', ''], impl);
    expect(covers).toEqual({});
    expect(calls).toEqual([]);
  });
});

describe('cover helpers', () => {
  it('extractCoverImage handles inline, html img and reference style', () => {
    expect(extractCoverImage('![banner](hero.png)')).toBe('hero.png');
    expect(extractCoverImage('<img src="assets/logo.png" width="400">')).toBe('assets/logo.png');
    expect(extractCoverImage('![cover][img]\n\n[img]: https://example.com/c.png')).toBe('https://example.com/c.png');
    expect(extractCoverImage('![v](https://img.shields.io/npm/v/x)')).toBeNull();
    expect(extractCoverImage('no images at all')).toBeNull();
  });

  it('coverCandidates rejects traversal and keeps https only', () => {
    expect(coverCandidates('x', '1.0.0', '../../etc/passwd', null)).toEqual([]);
    expect(coverCandidates('x', '1.0.0', 'http://insecure.io/a.png', null)).toEqual(['https://insecure.io/a.png']);
    expect(coverCandidates('x', '1.0.0', 'banner.png', { slug: 'o/r', dir: 'packages/x' })[3]).toBe('https://cdn.jsdelivr.net/gh/o/r@master/packages/x/banner.png');
  });
});
