import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// IPC 通道对齐防回归：preload 的 invoke helper 会自动加 local-pi: 前缀，main 侧
// handle() 同样加前缀注册。曾因 dingtalkRegister 用裸 ipcRenderer.invoke（无前缀）
// 调用带前缀注册的通道，点「一键配置」必报 No handler（PR #49 起一直坏，#77 修复）。
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
