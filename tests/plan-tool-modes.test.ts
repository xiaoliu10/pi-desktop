import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PiBackend } from '../src/main/pi/backend';
import { SessionIndex } from '../src/main/pi/session-index';
import type { PiEvent } from '../src/shared/pi';
import { PiRpcClient } from '../src/main/pi/rpc-client';

// desktop_update_plan（任务清单）必须全模式可用：用户 2026-10-18 实测 plan→fullAccess
// 切换后侧栏「进程」区块空掉，看起来像功能坏了——真实原因是 --tools 只在 plan 模式
// 注入了它。默认权限是 autoedit，普通用户永远踩这个坑。
const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(r => fs.rmSync(r, { recursive: true, force: true })); });

import { afterEach } from 'vitest';

async function launchWith(permission: 'plan' | 'ask' | 'autoEdit' | 'fullAccess') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-tools-')); roots.push(root);
  const owned = path.join(root, 'desktop'); fs.mkdirSync(owned);
  const events: PiEvent[] = [];
  const backend = new PiBackend(
    { executable: process.execPath, supported: true, agentDir: root, sessionDirs: [root], diagnostics: [] },
    new SessionIndex([owned], owned), owned,
    path.resolve('extensions/desktop-policy/index.mjs'), event => events.push(structuredClone(event)),
  );
  let launchArgs: string[] = [];
  backend.clientFactory = (_command, args, cwd, env) => {
    launchArgs = args;
    return new PiRpcClient(process.execPath, [path.resolve('tests/fixtures/fake-pi.mjs'), ...args], cwd, env);
  };
  await backend.connect({ cwd: root, trustProject: false, permission });
  return launchArgs;
}

describe('task checklist tool availability', () => {
  it('plan mode always passes the checklist in its tool whitelist', async () => {
    // plan 是唯一显式传 --tools 的模式（白名单语义：不传=全放行，见 pi 内核
    // agent-session.js:1126）。它曾把 desktop_update_plan 硬编码在白名单里——本次改为
    // 从统一注入点补，行为不变但不再有「切到其他模式后清单消失」的困惑源头。
    const args = await launchWith('plan');
    const toolsIndex = args.indexOf('--tools');
    expect(toolsIndex).toBeGreaterThan(-1);
    const tools = args[toolsIndex + 1]!.split(',');
    expect(tools).toContain('desktop_update_plan');
    expect(tools.filter(t => t === 'desktop_update_plan').length).toBe(1); // 不重复注入
  });

  it('modes without an explicit tool list keep the kernel default (checklist allowed)', async () => {
    // ask/autoEdit/fullAccess 不传 --tools ⇒ pi 放行全部已注册工具，扩展注册的
    // desktop_update_plan 因此可用。这条钉住「不要为了清单给这些模式强加白名单」——
    // 强加会顺手砍掉 bash/edit 等默认工具。
    for (const permission of ['ask', 'autoEdit', 'fullAccess'] as const) {
      const args = await launchWith(permission);
      expect(args, permission).not.toContain('--tools');
    }
  });

  it('keeps the plan mode read-only shape (only read/grep/find/ls + ask + checklist)', async () => {
    const args = await launchWith('plan');
    const tools = args[args.indexOf('--tools') + 1]!.split(',');
    expect(tools.filter(t => !['read', 'grep', 'find', 'ls', 'ask_user_question', 'desktop_update_plan'].includes(t))).toEqual([]);
    expect(tools.filter(t => t === 'desktop_update_plan').length).toBe(1); // 不重复注入
  });
});
