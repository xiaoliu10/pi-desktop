import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// 2026-10-23 实测：更新横幅里裸 `process.platform === 'darwin'` 在 renderer
// （无 Node 全局）一渲染就 ReferenceError，整个 React 树崩掉（renderer.log
// 「process is not defined」）。契约：renderer/shared 源码不得引用 process 全局；
// 主进程入口的取证钩子必须覆盖所有窗口的导航（heisenbug：窗口整页渲染 bundle
// 源码文本却零 will-navigate/did-navigate 痕迹，无留痕则无法根因）。

function walkSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkSources(p));
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) out.push(p);
  }
  return out;
}

describe('renderer 源码不引用 Node process 全局', () => {
  it('src/renderer 与 src/shared 无裸 process.* 引用', () => {
    const offenders: string[] = [];
    for (const dir of ['src/renderer', 'src/shared']) {
      for (const file of walkSources(dir)) {
        const src = fs.readFileSync(file, 'utf8');
        if (/(?<![\w.$'"`])process\.[A-Za-z_$]/.test(src)) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('主进程入口对所有窗口留导航取证痕（did-start-navigation）且窗口级 launch 语义', () => {
    const src = fs.readFileSync('src/main/index.ts', 'utf8');
    // web-contents-created 的通用分支（非 webview）也要挂取证，不能只挂 mainWindow
    expect(src).toContain('did-start-navigation');
    expect(src).toMatch(/--- window recreated/); // 区分进程首次启动与窗口重建（同 pid 双 launch 行曾误导排查）
  });
});
