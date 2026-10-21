// 0.1.32 发布事故回归：index worker 住 utility process，而 utility process 读不了
// asar —— 入口与全部 require 闭包必须在 asarUnpack 里，缺一个就 MODULE_NOT_FOUND
// code=1，三次重启全崩后 fatal，会话列表全空。前次修复只手工列了 6 个文件，
// 漏了 session-index 的传递依赖（session-size/history-window/subagent-snapshots/
// usage-stats/shared/subagent-workflow），打包后照样崩。
//
// 本测试从 worker 入口的 TS 源码递归解析相对 import（排除 import type），映射到
// dist 产物路径，断言每个文件都被某条 asarUnpack 规则覆盖。未来 worker 新增依赖
// 而 unpack 规则没跟上时，这里红。
import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');

/** Extract relative, value-level imports (the ones that become runtime requires). */
function relativeImports(file: string): string[] {
  const src = fs.readFileSync(file, 'utf8');
  const out: string[] = [];
  // 一行一个 import/export ... from '...'；import type 行是纯类型，编译后消失，跳过。
  for (const m of src.matchAll(/(?:^|\n)\s*(import|export)\s+(?:type\s+)?[\s\S]*?from\s+'([^']+)'/g)) {
    if (m[2].startsWith('.')) out.push(m[2]);
  }
  return out;
}

/** Recursively resolve the worker's local module closure, rooted at the worker entry. */
function closure(entry: string): string[] {
  const seen = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const rel of relativeImports(file)) {
      const target = path.resolve(path.dirname(file), rel);
      for (const candidate of [`${target}.ts`, path.join(target, 'index.ts')]) {
        if (fs.existsSync(candidate)) { walk(candidate); break; }
      }
    }
  };
  walk(entry);
  return [...seen];
}

/** Minimal glob match supporting `**` (any segments) and `*` (within a segment). */
function globToRegExp(pattern: string): RegExp {
  const re = pattern
    .split('/')
    .map(seg => seg === '**' ? '(?:.+\/)?(.+)' : seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))
    .join('/');
  return new RegExp(`^${re}$`);
}

it('index worker require closure is fully covered by asarUnpack', () => {
  const entry = path.join(root, 'src/main/pi/index-worker-entry.ts');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const rules: string[] = pkg.build.asarUnpack;
  const matchers = rules.map(globToRegExp);
  const distPath = (src: string) => {
    const rel = path.relative(root, src);
    return rel.replace(/^src\//, 'dist/').replace(/\.ts$/, '.js');
  };
  const uncovered = closure(entry)
    .map(distPath)
    .filter(p => !matchers.some(re => re.test(p)));
  expect(uncovered, 'worker 依赖未进 asarUnpack，utility process 将 MODULE_NOT_FOUND（0.1.32 会话列表全空事故）').toEqual([]);
});

it('host.ts rewrites app.asar to app.asar.unpacked for the worker entry', () => {
  const src = fs.readFileSync(path.join(root, 'src/main/pi/host.ts'), 'utf8');
  expect(src).toMatch(/app\.asar\.unpacked/);
  expect(src).toMatch(/replace\(`\$\{path\.sep\}app\.asar\$\{path\.sep\}`/);
});
