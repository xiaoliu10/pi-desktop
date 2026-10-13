import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { sidebarVersionLabel } from '../src/renderer/pi/PiReplicaApp';

// PR #89（bd10c95）只落了数据层（PiEnvironment.desktopVersion + host 注入）与 CSS，
// 漏了 index.ts 的第 5 参接线与 renderer 消费层——生产环境 desktopVersion 恒 undefined，
// 侧栏永远只显示 pi 版本。本文件锁住三层：label 组装、降级路径、main 接线。

describe('sidebarVersionLabel', () => {
  it('desktopVersion 存在：Desktop 在前（PR #89 意图）', () => {
    expect(sidebarVersionLabel({ version: '1.1.0', desktopVersion: '0.1.17' })).toBe('Desktop 0.1.17 · pi 1.1.0');
  });

  it('desktopVersion 缺失/为空：降级单段，不出现 "Desktop undefined"', () => {
    expect(sidebarVersionLabel({ version: '1.1.0' })).toBe('pi 1.1.0');
    expect(sidebarVersionLabel({ version: '1.1.0', desktopVersion: '' })).toBe('pi 1.1.0');
    expect(sidebarVersionLabel({ version: '1.1.0', desktopVersion: undefined })).toBe('pi 1.1.0');
  });

  it('version 缺失：显示「未发现」占位，与旧行为一致', () => {
    expect(sidebarVersionLabel({ desktopVersion: '0.1.17' })).toBe('Desktop 0.1.17 · pi 未发现');
    expect(sidebarVersionLabel({})).toBe('pi 未发现');
  });

  it('env 为 undefined/null：不抛错，降级单段', () => {
    expect(sidebarVersionLabel(undefined)).toBe('pi 未发现');
    expect(sidebarVersionLabel(null)).toBe('pi 未发现');
  });
});

// P1 防回归：#89 漏改了 index.ts 里唯一的 PiHost 生产实例化点（第 5 参 appVersion 未传，
// withAppVersion 的 if (this.appVersion) 恒假 → desktopVersion 永不写入）。
it('main/index.ts 的 host = new PiHost(...) 传入 app.getVersion()（desktopVersion 注入接线）', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  const at = src.indexOf('host = new PiHost(');
  expect(at).toBeGreaterThan(-1);
  const line = src.slice(at, src.indexOf('\n', at));
  expect(line).toContain('app.getVersion()');
});
