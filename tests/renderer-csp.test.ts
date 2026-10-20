import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// CSP 与图片渲染的契约回归。聊天图片走 image-url.ts 的 URL.createObjectURL（blob: URL，
// 为压 base64 常驻内存而选），所以 img-src 必须显式放行 blob:——少了它浏览器只报
// 「Refused to load the image ... violates CSP」而 UI 侧无任何异常，表现为裂图。
// 用例断言真实源文件（非字符串副本），index.html 若被改回去这里立刻红。
//
// 路径用 import.meta.url 解析：不依赖 vitest 的 cwd（仓库里两种写法都有，URL 形式
// 在「从子目录起 vitest / 编辑器单测」时不会挂）。

const html = readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8');

/** 取 CSP meta 的 content，再按指令名查。先锚定整条 content，避免 'src'/'t-src' 之类
 *  前缀匹配到 default-src/script-src 内部，也避免 content 改单引号时越过闭合引号。 */
function directive(name: string): string | undefined {
  const meta = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]*)"/);
  const content = meta?.[1] ?? '';
  return content.split(';').map(s => s.trim()).find(s => s.startsWith(`${name} `));
}

function tokens(name: string): string[] {
  return directive(name)!.slice(name.length).trim().split(/\s+/);
}

describe('renderer CSP', () => {
  it('declares the CSP meta at all (missing = no test signal)', () => {
    expect(html).toMatch(/http-equiv="Content-Security-Policy"/);
    expect(directive('img-src'), 'index.html must declare img-src').toBeTruthy();
  });

  it('img-src allows blob: for createObjectURL images', () => {
    expect(tokens('img-src')).toContain('blob:');
  });

  it('keeps img-src self/data/https (existing sources must not be dropped)', () => {
    const sources = tokens('img-src');
    expect(sources).toContain("'self'");
    expect(sources).toContain('data:');
    expect(sources).toContain('https:');
  });

  it('script-src stays self-only (no unsafe-inline/eval regression)', () => {
    const sources = tokens('script-src');
    expect(sources).toContain("'self'");
    expect(sources).not.toContain("'unsafe-inline'");
    expect(sources).not.toContain("'unsafe-eval'");
    expect(sources).not.toContain("'wasm-unsafe-eval'");
  });

  // 灯箱下载走 fetch(blob:) 把内存 blob 读回字节再转 data URL（见
  // src/shared/image-download.ts）。blob: 只放行 img-src 不够：fetch 受 connect-src
  // 约束，缺省回退 default-src 'self' 会被拒（真实 Electron 实测 Failed to fetch，
  // 下载原图静默失败）。必须显式 connect-src 放行 blob:，但不能放开 http/https 出口。
  it('connect-src allows blob: for download fetch without opening network egress', () => {
    const sources = tokens('connect-src');
    expect(sources).toContain('blob:');
    expect(sources).toContain("'self'");
    // 只允许渲染进程自建的内存 blob 与自身，不得出现任意网络/数据出口。
    expect(sources).not.toContain('http:');
    expect(sources).not.toContain('https:');
    expect(sources).not.toContain('ws:');
    expect(sources).not.toContain('wss:');
    expect(sources).not.toContain('data:');
    expect(sources).not.toContain('*');
  });
});
