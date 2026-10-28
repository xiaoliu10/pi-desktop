import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const entry = path.resolve('extensions/session-handoff/index.mjs');
async function fixture(opts: { mode?: string; busy?: boolean; desktop?: boolean; sidecar?: boolean } = {}) {
  const handlers = new Map<string, Function[]>();
  const tools = new Map<string, any>();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-plugin-')));
  const file = path.join(root, 'session.jsonl');
  fs.writeFileSync(file, '{}\n');
  let busy = !!opts.busy;
  const ctx: any = {
    mode: opts.mode ?? 'tui', cwd: root, hasUI: true,
    isIdle: () => !busy,
    sessionManager: {getSessionFile: () => file, getSessionId: () => 'session-id', getHeader: () => opts.sidecar ? {parentSession: 'parent'} : {}},
    ui: {notify: vi.fn(), input: vi.fn(async () => JSON.stringify({ok: true, sessions: []}))},
  };
  let receive: Function | undefined;
  const peer = {list: vi.fn(async () => []), send: vi.fn(async () => ({ok: true})), close: vi.fn(async () => {}), update: vi.fn(async () => {})};
  const transport = {startPeer: vi.fn(async (args: any) => { receive = args.receive; return peer; })};
  const pi: any = {
    on: (name: string, fn: Function) => {handlers.set(name, [...(handlers.get(name) ?? []), fn]);},
    registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: vi.fn(),
    getSessionName: () => 'test',
    sendUserMessage: vi.fn((text: string) => {busy = true; setImmediate(() => emit('before_agent_start', {prompt: text}));}),
  };
  async function emit(name: string, event = {}) {for (const fn of handlers.get(name) ?? []) await fn(event, ctx);}
  const mod = await import(pathToFileURL(entry).href);
  mod.default(pi, {transport, env: opts.desktop ? {PI_DESKTOP_HANDOFF_BRIDGE: '1'} : {}, registryDir: path.join(root, 'registry'), receiptTimeoutMs: 30});
  return {pi, ctx, peer, transport, tools, emit, root, receive: () => receive!, setBusy: (value: boolean) => {busy = value;}};
}

describe('portable handoff plugin', () => {
  it('registers without opening resources; starts for TUI and closes on shutdown', async () => {
    const f = await fixture();
    expect(f.tools.has('session_handoff')).toBe(true);
    expect(f.transport.startPeer).not.toHaveBeenCalled();
    await f.emit('session_start');
    expect(f.transport.startPeer).toHaveBeenCalledTimes(1);
    await f.emit('session_shutdown');
    expect(f.peer.close).toHaveBeenCalledTimes(1);
  });
  it('injects a user envelope and waits for actual before_agent_start receipt', async () => {
    const f = await fixture(); await f.emit('session_start');
    const result = await f.receive()({message: 'Fix in project B', source: {cwd: '/project-a'}, idempotencyKey: 'one'});
    expect(result.disposition).toBe('started');
    expect(f.pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining('Fix in project B'), {deliverAs: 'followUp', expandPromptTemplates: false});
  });
  it('queues busy targets without interrupting; settled flushes one and reload retires receiver', async () => {
    const f = await fixture({busy: true}); await f.emit('session_start');
    expect((await f.receive()({message: 'queued', source: {}, idempotencyKey: 'two'})).disposition).toBe('queued');
    expect(f.pi.sendUserMessage).not.toHaveBeenCalled();
    f.setBusy(false); await f.emit('agent_settled');
    await new Promise(r => setTimeout(r, 10));
    expect(f.pi.sendUserMessage).toHaveBeenCalledTimes(1);
    const receive = f.receive(); await f.emit('session_shutdown');
    await expect(receive({message: 'late', source: {}})).rejects.toThrow(/关闭|失效/);
  });
  it('does not return started when the runtime silently rejects an injection', async () => {
    const f = await fixture(); await f.emit('session_start');
    f.pi.sendUserMessage.mockImplementation(() => {});
    await expect(f.receive()({message: 'no auth', source: {}, idempotencyKey: 'reject'})).rejects.toThrow(/确认|回执/);
  });
  it('does not advertise sidecars or print-only sessions as receivers', async () => {
    for (const opts of [{sidecar: true}, {mode: 'print'}]) {
      const f = await fixture(opts); await f.emit('session_start');
      expect(f.transport.startPeer).not.toHaveBeenCalled();
      await f.emit('session_shutdown');
    }
  });
  it('uses Desktop bridge only when explicitly enabled, preserving disconnected-target lookup', async () => {
    const f = await fixture({desktop: true}); await f.emit('session_start');
    await f.tools.get('session_handoff').execute('call', {action: 'list', projectPath: f.root}, undefined, undefined, f.ctx);
    expect(f.ctx.ui.input).toHaveBeenCalledWith('desktop-handoff', expect.any(String));
    await f.emit('session_shutdown');
  });
});
