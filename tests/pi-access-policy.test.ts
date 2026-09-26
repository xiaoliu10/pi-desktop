import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error Runtime pi extensions are native JS modules.
import { classify, approvalMessage } from '../extensions/desktop-policy/policy.mjs';
// @ts-expect-error Runtime pi extensions are native JS modules.
import desktopPolicy from '../extensions/desktop-policy/index.mjs';
let root: string, cwd: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-policy-')); cwd = path.join(root, 'project'); fs.mkdirSync(cwd); });
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });
const decision = (mode: string, tool: string, input = {}, builtin = true) => classify({ mode, tool, input, builtin, cwd });
describe('access policy matrix', () => {
 it('permits native project reads, asks for shell and unknown tools, gates writes by mode', () => {
  for (const mode of ['plan', 'ask', 'autoEdit', 'fullAccess']) {
   expect(decision(mode, 'read', { path: 'app.ts' }).action).toBe('allow');
   expect(decision(mode, 'write', { path: 'app.ts' }).action).toBe(mode === 'plan' ? 'deny' : mode === 'ask' ? 'ask' : 'allow');
   expect(decision(mode, 'bash', { command: 'npm test' }).action).toBe(mode === 'plan' ? 'deny' : mode === 'fullAccess' ? 'allow' : 'ask');
   expect(decision(mode, 'read', { path: 'app.ts' }, false).action).toBe(mode === 'plan' ? 'deny' : mode === 'fullAccess' ? 'allow' : 'ask');
  }
 });
 it('does not auto-allow escapes, sensitive files or symlinks outside the project', () => {
  fs.symlinkSync(root, path.join(cwd, 'outside'));
  for (const target of ['../secret', 'outside/new.txt', '.env', '.pi/extensions/new.ts', '.git/config', 'AGENTS.md']) {
   expect(decision('autoEdit', 'write', { path: target }).action).toBe('ask');
   expect(decision('plan', 'read', { path: target }).action).toBe('deny');
  }
  expect(decision('garbage', 'read').action).toBe('deny');
 });
 it('previews exact replacement text with the target and work directory', () => {
  const target = path.join(cwd, 'a.txt'); fs.writeFileSync(target, 'old');
  const event = { toolName: 'write', input: { path: 'a.txt', content: 'new' } };
  const preview = approvalMessage(event, decision('ask', 'write', event.input), cwd);
  expect(preview).toContain('- old'); expect(preview).toContain('+ new'); expect(preview).toContain(target);
 });
});
function harness(mode = 'ask', select = vi.fn().mockResolvedValue('拒绝')) {
 vi.stubEnv('PI_DESKTOP_PERMISSION', mode);
 // 隔离外部 Desktop 连接的模式控制文件（如从 Desktop 内发起测试时继承的 PI_DESKTOP_MODE_FILE）。
 vi.stubEnv('PI_DESKTOP_MODE_FILE', '');
 const handlers: Record<string, Function> = {};
 const pi = { registerTool: vi.fn(), on: (name: string, fn: Function) => { handlers[name] = fn; }, getAllTools: () => ['read', 'write', 'bash'].map(name => ({ name, sourceInfo: { source: 'builtin' } })), getActiveTools: () => ['read', 'write', 'bash'], setActiveTools: vi.fn(), appendEntry: vi.fn() };
 desktopPolicy(pi);
 const ctx = { cwd, signal: new AbortController().signal, ui: { select, setStatus: vi.fn() } };
 return { handlers, pi, ctx, select };
}
it('denied writes never reach execution; approvals are not reused', async () => {
 const { handlers, ctx, select } = harness();
 const event = { toolName: 'write', toolCallId: 'one', input: { path: 'blocked.txt', content: 'bad' } };
 for (let i = 0; i < 2; i++) { const result = await handlers.tool_call(event, ctx); if (!result?.block) fs.writeFileSync(path.join(cwd, 'blocked.txt'), 'bad'); }
 expect(fs.existsSync(path.join(cwd, 'blocked.txt'))).toBe(false); expect(select).toHaveBeenCalledTimes(2);
});
it('approved writes execute, but file changes during confirmation invalidate approval', async () => {
 const target = path.join(cwd, 'a.txt'); fs.writeFileSync(target, 'old');
 const h = harness('ask', vi.fn().mockResolvedValue('允许'));
 const event = { toolName: 'write', toolCallId: 'one', input: { path: 'a.txt', content: 'new' } };
 expect(await h.handlers.tool_call(event, h.ctx)).toBeUndefined();
 h.select.mockImplementation(async () => { fs.writeFileSync(target, 'concurrent change'); return '允许'; });
 expect((await h.handlers.tool_call(event, h.ctx)).block).toBe(true);
 expect(fs.readFileSync(target, 'utf8')).toBe('concurrent change');
});
it('parameter changes and cancellation invalidate the approval', async () => {
 const event = { toolName: 'bash', toolCallId: 'one', input: { command: 'pwd' } };
 const h = harness('ask', vi.fn(async () => { event.input.command = 'rm something'; return '允许'; }));
 expect((await h.handlers.tool_call(event, h.ctx)).block).toBe(true);
 const controller = new AbortController(); controller.abort();
 expect((await h.handlers.tool_call(event, { ...h.ctx, signal: controller.signal })).block).toBe(true);
});
it('plan mode restricts active tools and adds planning instructions', () => {
 const h = harness('plan'); h.handlers.session_start({}, h.ctx);
 expect(h.pi.setActiveTools).toHaveBeenCalledWith(['read', 'desktop_update_plan']);
 expect(h.handlers.before_agent_start({ systemPrompt: 'base' }).systemPrompt).toContain('计划模式');
 expect(h.pi.appendEntry).toHaveBeenCalledWith('desktop-policy-audit', expect.objectContaining({ mode: 'plan' }));
});

it('keeps approval pending beyond two minutes and approves only after the user responds', async () => {
 vi.useFakeTimers();
 try {
  let resolve!: (choice:string)=>void;
  const select=vi.fn((_title,_options,opts)=>new Promise<string>(r=>{
   resolve=r;
   if(opts?.timeout) setTimeout(()=>r(false),opts.timeout);
   opts?.signal?.addEventListener('abort',()=>r(false),{once:true});
  }));
  const h=harness('ask',select);
  let settled=false;
  const waiting=h.handlers.tool_call({toolName:'write',toolCallId:'long',input:{path:'later.txt',content:'approved'}},h.ctx).then((result:any)=>{settled=true;return result;});
  await vi.advanceTimersByTimeAsync(24*60*60*1000);
  expect(settled).toBe(false);
  expect(select.mock.calls[0][2]).toEqual({signal:h.ctx.signal});
  resolve('允许');expect(await waiting).toBeUndefined();
 } finally { vi.useRealTimers(); }
});
it('cancels a pending approval through the task abort signal',async()=>{
 const controller=new AbortController();
 const h=harness('ask',vi.fn((_title,_options,opts)=>new Promise(resolve=>opts.signal.addEventListener('abort',()=>resolve(undefined),{once:true}))));
 const waiting=h.handlers.tool_call({toolName:'write',toolCallId:'stop',input:{path:'stop.txt',content:'never'}},{...h.ctx,signal:controller.signal});
 controller.abort();expect((await waiting).block).toBe(true);
});
