// desktop_schedule 定时任务工具全链路：
// ① 扩展侧：调度规则归一化（once/interval/cron、过去时间拒绝）+ 保留 ui.input 通道 + 应答渲染；
// ② 桥接侧：权限护栏（不高于创建会话）、create/list/cancel 分发、错误 fail-closed；
// ③ 集成：真实 AutomationService 落盘 automations.json → 到点前可取消。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runAutomationBridge, SCHEDULE_GUIDANCE, type AutomationBridgeService } from '../src/main/pi/automation-bridge';
import { AutomationService } from '../src/main/pi/automation-service';

it('schedule guidance is injected via launch args whenever the extension ships (source contract)', () => {
  const backend = fs.readFileSync('src/main/pi/backend.ts', 'utf8');
  expect(backend).toContain('SCHEDULE_GUIDANCE');
  expect(backend).toContain("scheduleArgs.length");
  expect(SCHEDULE_GUIDANCE).toContain('desktop_schedule');
});

function fakeService(): AutomationBridgeService & { calls: [string, unknown][] } {
  const calls: [string, unknown][] = [];
  return {
    calls,
    saveTask: vi.fn((task: any) => {
      calls.push(['save', task]);
      return { id: 'task-1', runCount: 0, updatedAt: 1, args: {}, ...task, nextRunAt: (task.schedule as any)?.at ?? 42 } as any;
    }),
    deleteTask: vi.fn((id: string) => { calls.push(['delete', id]); }),
    snapshot: vi.fn(() => ({ tasks: [{ id: 'a', name: 'A', schedule: { kind: 'once', at: 1 }, enabled: true, nextRunAt: 1, runCount: 2 } as any] })),
  };
}

describe('runAutomationBridge', () => {
  const ctx = { cwd: '/tmp/proj', permission: 'ask' as const };

  it('create validates with the service and clamps permission to the creating session', () => {
    const service = fakeService();
    const result = runAutomationBridge(service, ctx, JSON.stringify({ action: 'create', name: ' 今晚发版 ', prompt: 'deploy', schedule: { kind: 'once', at: 1790000000000 }, permission: 'full' }));
    expect(result.ok).toBe(true);
    expect(service.calls[0]).toEqual(['save', expect.objectContaining({ cwd: '/tmp/proj', name: '今晚发版', permission: 'ask', enabled: true })]);
    expect((result as any).task.id).toBe('task-1');
  });

  it('create inherits the session permission when not specified; plan sessions map to ask', () => {
    const service = fakeService();
    runAutomationBridge(service, { cwd: ctx.cwd, permission: 'autoedit' }, JSON.stringify({ action: 'create', name: 'x', prompt: 'p', schedule: { kind: 'once', at: 1790000000000 } }));
    expect((service.calls[0][1] as any).permission).toBe('autoedit');
    runAutomationBridge(service, { cwd: ctx.cwd, permission: 'plan' }, JSON.stringify({ action: 'create', name: 'x', prompt: 'p', schedule: { kind: 'once', at: 1790000000000 } }));
    expect((service.calls[1][1] as any).permission).toBe('ask');
  });

  it('list works without a service; create/cancel require one', () => {
    expect(runAutomationBridge(undefined, ctx, JSON.stringify({ action: 'list' }))).toMatchObject({ ok: true, tasks: [] });
    expect(runAutomationBridge(undefined, ctx, JSON.stringify({ action: 'create', name: 'x', prompt: 'p', schedule: { kind: 'once', at: 1790000000000 } })).ok).toBe(false);
    expect(runAutomationBridge(fakeService(), ctx, JSON.stringify({ action: 'cancel', id: 'a' }))).toEqual({ ok: true, action: 'cancel' });
  });

  it('fails closed on stopping, malformed payloads, and unknown actions', () => {
    expect(runAutomationBridge(fakeService(), { ...ctx, stopping: true }, JSON.stringify({ action: 'list' })).ok).toBe(false);
    expect(runAutomationBridge(fakeService(), ctx, 'not-json').ok).toBe(false);
    expect(runAutomationBridge(fakeService(), ctx, JSON.stringify({ action: 'pause' })).error).toContain('create / list / cancel');
  });
});

describe('desktop_schedule extension', () => {
  async function loadTool() {
    const mod = await import('../extensions/desktop-schedule/index.mjs');
    const tools: Record<string, any> = {};
    (mod.default as any)({ registerTool: (t: any) => { tools[t.name] = t; } });
    return tools['desktop_schedule'] as any;
  }

  function fakeCtx(reply: string | undefined) {
    const captured: { title: string; payload: string }[] = [];
    const ui = { input: vi.fn(async (title: string, payload: string) => { captured.push({ title, payload }); return reply; }) };
    return { captured, ctx: { ui } };
  }

  it('create normalizes once-ISO to epoch ms and renders the confirmation', async () => {
    const tool = await loadTool();
    const { captured, ctx } = fakeCtx(JSON.stringify({ ok: true, action: 'create', task: { id: 't', name: '今晚发版', nextRunAt: Date.now() + 60000 } }));
    const at = new Date(Date.now() + 120000).toISOString();
    const result = await tool.execute('c1', { action: 'create', name: '今晚发版', prompt: 'deploy', schedule: { kind: 'once', at } }, undefined, undefined, ctx);
    expect(captured[0].title).toBe('desktop-automation');
    const sent = JSON.parse(captured[0].payload);
    expect(sent.schedule).toEqual({ kind: 'once', at: Date.parse(at) });
    expect(result.content[0].text).toContain('已创建定时任务「今晚发版」');
  });

  it('rejects one-shot times in the past and unknown schedule kinds before contacting Desktop', async () => {
    const tool = await loadTool();
    const { ctx } = fakeCtx(JSON.stringify({ ok: true }));
    await expect(tool.execute('c2', { action: 'create', name: 'x', prompt: 'p', schedule: { kind: 'once', at: Date.now() - 1000 } }, undefined, undefined, ctx)).rejects.toThrow('必须在未来');
    await expect(tool.execute('c3', { action: 'create', name: 'x', prompt: 'p', schedule: { kind: 'whenever' } }, undefined, undefined, ctx)).rejects.toThrow('once / interval / cron');
  });

  it('surfaces Desktop-side failures and cancellations without throwing', async () => {
    const tool = await loadTool();
    const fail = fakeCtx(JSON.stringify({ ok: false, error: '自动化服务不可用' }));
    const failed = await tool.execute('c4', { action: 'list' }, undefined, undefined, fail.ctx);
    expect(failed.content[0].text).toContain('操作失败：自动化服务不可用');
    const cancel = fakeCtx(undefined);
    const cancelled = await tool.execute('c5', { action: 'list' }, undefined, undefined, cancel.ctx);
    expect(cancelled.details).toMatchObject({ cancelled: true });
  });
});

describe('bridge + real AutomationService', () => {
  it('persists a scheduled task to automations.json and cancels it', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'auto-bridge-')));
    const file = path.join(dir, 'automations.json');
    const service = new AutomationService(file, () => ({}) as any);
    try {
      const at = Date.now() + 60000;
      const result = runAutomationBridge(service, { cwd: dir, permission: 'fullAccess' }, JSON.stringify({ action: 'create', name: '今晚 22:00 发版', prompt: '执行 deploy-20261002.sh', schedule: { kind: 'once', at } }));
      expect(result.ok).toBe(true);
      const task = service.snapshot().tasks[0];
      expect(task).toMatchObject({ name: '今晚 22:00 发版', enabled: true, permission: 'fullAccess' });
      expect(task.nextRunAt).toBe(at);
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).tasks).toHaveLength(1);
      expect(runAutomationBridge(service, { cwd: dir, permission: 'full' }, JSON.stringify({ action: 'cancel', id: task.id })).ok).toBe(true);
      expect(service.snapshot().tasks).toHaveLength(0);
    } finally {
      service.dispose();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
