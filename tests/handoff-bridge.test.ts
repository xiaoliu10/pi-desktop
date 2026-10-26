import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HandoffService, runHandoffBridge, handoffEnvelope } from '../src/main/pi/handoff-bridge';
import type { PiSession } from '../src/shared/pi';

// 跨会话交接：A 会话把排查信息投递给目标项目最近活跃的未归档会话 B，
// B 运行中则 followUp 排队，未连接则按 sourceKey 重连后投递；归档/副驾/
// 其他项目的会话不得被选中。
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-root-')));
const A = path.join(ROOT, 'proj-a'), B = path.join(ROOT, 'proj-b');
for (const d of [A, B]) fs.mkdirSync(d, { recursive: true });

function session(partial: Partial<PiSession> & { key: string; cwd: string }): PiSession {
  return { id: partial.key, path: `/sess/${partial.key}.jsonl`, name: partial.key, updatedAt: 1, size: 10, warnings: [], owned: true, ...partial };
}

function setup(index: PiSession[], opts: { runs?: any[]; archived?: string[]; remembered?: Record<string, any> } = {}) {
  const prompt = vi.fn(async () => runs.some(r => r.status === 'running') ? 'queued' : 'started');
  const connect = vi.fn(async (input: any) => ({ key: input.sourceKey ?? 'fresh' }));
  const runs = opts.runs ?? [];
  const service = new HandoffService({
    index: { scan: () => index },
    archivedKeys: () => opts.archived ?? [],
    backend: { runs: () => runs, prompt, connect },
    rememberedMode: (key: string) => opts.remembered?.[key],
  });
  const ctx = { cwd: A, sourceSessionKey: 'keyA', permission: 'ask' as const };
  return { service, ctx, prompt, connect, runs };
}

describe('handoff target resolution', () => {
  it('picks the most recently updated non-archived, non-sidecar, owned session of the project', () => {
    const { service } = setup([
      session({ key: 'old', cwd: A, updatedAt: 999 }),                 // 别的项目，再新也不选
      session({ key: 'side', cwd: B, updatedAt: 998, sidecarOf: 'x' }), // 副驾
      session({ key: 'arch', cwd: B, updatedAt: 997 }),                // 已归档
      session({ key: 'older', cwd: B, updatedAt: 10 }),
      session({ key: 'newest', cwd: B, updatedAt: 100 }),
    ], { archived: ['arch'] });
    const t = service.resolveTarget({ projectPath: B });
    expect(t?.key).toBe('newest');
    expect(t?.connected).toBe(false);
  });

  it('prefers a connected run in the project even if its file mtime is older', () => {
    const { service } = setup(
      [session({ key: 'file-new', cwd: B, updatedAt: 100 }), session({ key: 'run-old', cwd: B, updatedAt: 1 })],
      { runs: [{ key: 'run-old', cwd: B, status: 'idle' }] },
    );
    const t = service.resolveTarget({ projectPath: B });
    expect(t?.key).toBe('run-old');
    expect(t?.connected).toBe(true);
  });

  it('honors an explicit sessionKey only when it belongs to the project and is not archived/a sidecar', () => {
    const { service } = setup([session({ key: 'b1', cwd: B, updatedAt: 1 }), session({ key: 'gone', cwd: B, updatedAt: 2 })], { archived: ['gone'] });
    expect(service.resolveTarget({ projectPath: B, sessionKey: 'b1' })?.key).toBe('b1');
    expect(() => service.resolveTarget({ projectPath: B, sessionKey: 'missing' })).toThrow(/不存在|已归档|不可用/);
    expect(() => service.resolveTarget({ projectPath: B, sessionKey: 'gone' })).toThrow(/归档/);
  });
});

describe('handoff dispatch', () => {
  it('idle connected target: prompts with the handoff envelope, disposition started', async () => {
    const { service, ctx, prompt } = setup(
      [session({ key: 'b1', cwd: B, updatedAt: 1, name: 'CCR 修复会话' })],
      { runs: [{ key: 'b1', cwd: B, status: 'idle' }] },
    );
    const result = await runHandoffBridge(service, ctx, JSON.stringify({ action: 'send', projectPath: B, message: 'Kimi 400 后回退中转 200 但流不完整' })) as any;
    expect(result.ok).toBe(true);
    expect(result.target).toMatchObject({ key: 'b1', disposition: 'started', connected: true });
    expect(prompt).toHaveBeenCalledTimes(1);
    const text = String(prompt.mock.calls[0][1]);
    expect(prompt.mock.calls[0][2]).toBe('followUp');
    expect(text).toContain('Kimi 400 后回退中转 200 但流不完整');
    expect(text).toContain('会话交接');
    expect(text).toContain(A);
  });

  it('running target: same call, disposition queued', async () => {
    const { service, ctx, prompt } = setup(
      [session({ key: 'b1', cwd: B, updatedAt: 1 })],
      { runs: [{ key: 'b1', cwd: B, status: 'running' }] },
    );
    const result = await runHandoffBridge(service, ctx, JSON.stringify({ projectPath: B, message: '排队等处理' })) as any;
    expect(result.target.disposition).toBe('queued');
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it('disconnected target: reconnects via sourceKey (remembered access mode wins), then prompts', async () => {
    const { service, ctx, connect, prompt } = setup(
      [session({ key: 'b1', cwd: B, updatedAt: 1 })],
      { remembered: { b1: 'fullAccess' } },
    );
    await runHandoffBridge(service, ctx, JSON.stringify({ projectPath: B, message: '重连我' }));
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ sourceKey: 'b1', cwd: B, permission: 'fullAccess' }));
    expect(prompt).toHaveBeenCalledWith('b1', expect.stringContaining('重连我'), 'followUp');
  });

  it('rejects missing project / non-directory / empty message / overlong message', async () => {
    const { service, ctx } = setup([session({ key: 'b1', cwd: B, updatedAt: 1 })]);
    expect((await runHandoffBridge(service, ctx, JSON.stringify({ message: 'x' }))).ok).toBe(false); // 无 projectPath 且源项目无会话
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-')));
    expect((await runHandoffBridge(service, ctx, JSON.stringify({ projectPath: dir, message: '' }))).error).toMatch(/message|消息/);
    expect((await runHandoffBridge(service, ctx, JSON.stringify({ projectPath: dir, message: 'x'.repeat(20001) }))).ok).toBe(false);
    expect((await runHandoffBridge(service, ctx, '{not json')).ok).toBe(false);
  });

  it('same idempotencyKey delivers once and reports duplicate', async () => {
    const { service, ctx, prompt } = setup(
      [session({ key: 'b1', cwd: B, updatedAt: 1 })],
      { runs: [{ key: 'b1', cwd: B, status: 'idle' }] },
    );
    const payload = JSON.stringify({ projectPath: B, message: '只投一次', idempotencyKey: 'k-1' });
    const first = await runHandoffBridge(service, ctx, payload) as any;
    const second = await runHandoffBridge(service, ctx, payload) as any;
    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: true, duplicate: true });
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it('concurrent duplicate idempotency keys share one delivery and do not repeat prompt', async () => {
    const { service, ctx, prompt } = setup(
      [session({ key: 'b1', cwd: B, updatedAt: 1 })],
      { runs: [{ key: 'b1', cwd: B, status: 'idle' }] },
    );
    const payload = JSON.stringify({ projectPath: B, message: '并发幂等', idempotencyKey: 'same-key' });
    const [first, second] = await Promise.all([
      runHandoffBridge(service, ctx, payload),
      runHandoffBridge(service, ctx, payload),
    ]);
    expect(first.ok && second.ok).toBe(true);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect([first.duplicate, second.duplicate].filter(Boolean)).toHaveLength(1);
  });

  it('list returns project candidates with connected state', async () => {
    const { service } = setup(
      [session({ key: 'b1', cwd: B, updatedAt: 1, name: 'B1' }), session({ key: 'b2', cwd: B, updatedAt: 2 })],
      { runs: [{ key: 'b2', cwd: B, status: 'running' }] },
    );
    const result = await runHandoffBridge(service, { cwd: A, sourceSessionKey: 'keyA', permission: 'ask' }, JSON.stringify({ action: 'list', projectPath: B })) as any;
    expect(result.ok).toBe(true);
    expect(result.sessions.map((s: any) => [s.key, s.connected, s.status])).toEqual([['b2', true, 'running'], ['b1', false, null]]);
  });

  it('rejects handing off to the source session itself (no self-trigger loop)', async () => {
    const { service, ctx, prompt } = setup(
      [session({ key: 'keyA', cwd: A, updatedAt: 1 })],
      { runs: [{ key: 'keyA', cwd: A, status: 'idle' }] },
    );
    const result = await runHandoffBridge(service, ctx, JSON.stringify({ projectPath: A, message: '别投给自己' })) as any;
    expect(result.ok).toBe(false);
    expect(result.error).toContain('相同');
    expect(prompt).not.toHaveBeenCalled();
  });

  it('envelope never fabricates fields', () => {
    const text = handoffEnvelope({ message: '正文', sourceCwd: A, sourceName: '源', now: new Date('2026-10-26T03:00:00Z') });
    expect(text).toContain('正文');
    expect(text).toContain('源');
  });
});

describe('desktop_handoff extension wiring', () => {
  it('shipped as an extension with the reserved ui.input channel and packaged as extraResource', () => {
    expect(fs.existsSync('extensions/desktop-handoff/index.mjs')).toBe(true);
    const ext = fs.readFileSync('extensions/desktop-handoff/index.mjs', 'utf8');
    expect(ext).toContain("name: 'desktop_handoff'");
    expect(ext).toContain("ctx.ui.input('desktop-handoff'");
    const backend = fs.readFileSync('src/main/pi/backend.ts', 'utf8');
    expect(backend).toContain("title === 'desktop-handoff'");
    expect(backend).toContain('desktop-handoff');
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    expect(JSON.stringify(pkg.build.extraResources)).toContain('extensions/desktop-handoff');
  });
});
