import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// IPC 通道对齐防回归：preload 的 invoke helper 会自动加 local-pi: 前缀，main 侧
// handle() 同样加前缀注册。曾因 dingtalkRegister 用裸 ipcRenderer.invoke（无前缀）
// 调用带前缀注册的通道，点「一键配置」必报 No handler（PR #49 起一直坏，#77 修复）。
// 前提假设（成立时本测试有效，破坏时会误报——误报方向安全）：
// - src/main/index.ts 是 local-pi:* 的唯一 handle 注册点；
// - 源码注释/字符串中不出现 invoke('…') / handle('…') 字样；
// - preload 的 localPi 段（const localPi 起）禁止任何裸 ipcRenderer.invoke，
//   新通道一律走 invoke helper（由下方结构断言强制）。
// 已知局限：preload 顶部遗留 api 组的裸 invoke 通道（app:info 等）属 legacy 死代码
// （调用方 components/ 不再挂载），main 无注册；断言②仅防未来 local-pi:* 撞名。
const preload = fs.readFileSync(path.resolve('src/preload/index.ts'), 'utf8');
const mainIndex = fs.readFileSync(path.resolve('src/main/index.ts'), 'utf8');

const helperChannels = [...preload.matchAll(/[^.\w]invoke\('([^']+)'/g)].map(m => m[1]!);
const bareChannels = [...preload.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map(m => m[1]!);
const mainHandled = [...mainIndex.matchAll(/[^\w.]handle\('([^']+)'/g)].map(m => m[1]!);

describe('IPC 通道名对齐（preload ↔ main local-pi:*）', () => {
  it('preload 经 helper 调用的每个通道都在 main 注册过', () => {
    const registered = new Set(mainHandled);
    const missing = helperChannels.filter(name => !registered.has(name));
    expect(missing, `main/index.ts 缺少 handle('${missing[0]}') 注册`).toEqual([]);
  });

  it('livePi 段禁止裸 ipcRenderer.invoke：新通道必须走 invoke helper', () => {
    const livePi = preload.slice(preload.indexOf('const localPi'));
    expect(livePi.length).toBeGreaterThan(0);
    const offenders = [...livePi.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map(m => m[1]!);
    expect(offenders, `localPi 段出现裸调用：'${offenders[0]}'——请改走 invoke helper`).toEqual([]);
  });

  it('裸 ipcRenderer.invoke 通道不得与 local-pi:* 注册同名（本 bug 形态）', () => {
    const registered = new Set(mainHandled);
    const collided = bareChannels.filter(name => registered.has(name));
    expect(collided, `通道 '${collided[0]}' 在 main 以 local-pi: 前缀注册，preload 却裸名调用——请改走 invoke helper`).toEqual([]);
  });

  it('dingtalkRegister 两通道经 helper 调用且 main 已注册', () => {
    expect(helperChannels).toContain('dingtalkRegister:start');
    expect(helperChannels).toContain('dingtalkRegister:poll');
    expect(bareChannels).not.toContain('dingtalkRegister:start');
    expect(bareChannels).not.toContain('dingtalkRegister:poll');
    expect(mainHandled).toContain('dingtalkRegister:start');
    expect(mainHandled).toContain('dingtalkRegister:poll');
  });
});
