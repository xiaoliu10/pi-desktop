import { afterEach, expect, it, vi } from 'vitest';
// @ts-expect-error Runtime extensions are native JS.
import retryContinuation from '../extensions/desktop-policy/retry-continuation.mjs';
afterEach(() => vi.unstubAllEnvs());
function setup() {
  vi.stubEnv('PI_DESKTOP_GENERATION', 'generation-a');
  const handlers: Record<string, Function> = {}, commands: Record<string, any> = {};
  const pi = { on: (name: string, fn: Function) => { handlers[name] = fn; }, registerCommand: (name: string, value: any) => { commands[name] = value; }, sendMessage: vi.fn() };
  retryContinuation(pi);
  const branch: any[] = [{ type: 'message', id: 'original', message: { role: 'user', content: 'USER-ORIGINAL-UNIQUE-REQUEST'  } }, { type: 'message', id: 'tool', message: { role: 'toolResult', content: [] } }, { type: 'message', id: 'failure', message: { role: 'assistant', stopReason: 'error' } }];
  const ctx = { sessionManager: { getSessionFile: () => '/tmp/session.jsonl', getBranch: () => branch }, isIdle: () => true, hasPendingMessages: () => false, ui: { setStatus: vi.fn() } };
  handlers.session_start({}, ctx);
  const request = { generation: 'generation-a', sessionFile: '/tmp/session.jsonl', entryId: 'failure', group: 2 };
  const dispatch = (patch = {}) => commands['desktop-retry-generation-a'].handler(JSON.stringify({ ...request, ...patch }), ctx);
  return { pi, ctx, handlers, branch, dispatch, commands };
}
it('dispatches a hidden continuation, not the original user input, once per failed entry', () => {
  const { pi, dispatch, branch } = setup(); const before = structuredClone(branch);
  dispatch(); expect(pi.sendMessage).toHaveBeenCalledTimes(1);
  expect(pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: 'desktop-retry-continuation', display: false }), { triggerTurn: true });
  expect(pi.sendMessage.mock.calls[0][0].content).not.toContain('USER-ORIGINAL-UNIQUE-REQUEST');
  expect(branch).toEqual(before);
  expect(() => dispatch()).toThrow('already dispatched');
});
it('rejects stale generations, sessions, entries and group numbers without side effects', () => {
  const { pi, dispatch } = setup();
  for (const patch of [{ generation: 'old' }, { sessionFile: '/other' }, { entryId: 'tool' }, { group: 11 }, { group: 1 }]) expect(() => dispatch(patch)).toThrow();
  expect(pi.sendMessage).not.toHaveBeenCalled();
});
it('rejects non-idle, queued, changed or shutdown context', () => {
  const { pi, dispatch, ctx, branch, handlers } = setup();
  ctx.isIdle = () => false; expect(() => dispatch()).toThrow('settled'); ctx.isIdle = () => true;
  ctx.hasPendingMessages = () => true; expect(() => dispatch()).toThrow('queue'); ctx.hasPendingMessages = () => false;
  branch.push({ type: 'custom_message', id: 'new' }); expect(() => dispatch()).toThrow('context changed'); branch.pop();
  handlers.session_shutdown(); expect(() => dispatch()).toThrow('Stale');
  expect(pi.sendMessage).not.toHaveBeenCalled();
});
it('settlement command waits for supported idle API and sends only the matching token', async () => {
  const { ctx, commands } = setup();
  let resolve!: () => void;
  const idle = new Promise<void>(r => { resolve = r; });
  const commandCtx = { ...ctx, waitForIdle: () => idle };
  const args = JSON.stringify({ generation: 'generation-a', sessionFile: '/tmp/session.jsonl', token: 'token-a' });
  const waiting = commands['desktop-retry-generation-a-settle'].handler(args, commandCtx);
  expect(ctx.ui.setStatus).not.toHaveBeenCalledWith('desktop-retry-settled', expect.anything());
  resolve(); await waiting;
  expect(ctx.ui.setStatus).toHaveBeenCalledWith('desktop-retry-settled', JSON.stringify({ generation: 'generation-a', token: 'token-a' }));
  await expect(commands['desktop-retry-generation-a-settle'].handler(args, ctx)).rejects.toThrow('lacks safe waitForIdle');
});
it('settlement command refuses a session switched while awaiting idle', async () => {
  const { ctx, commands, handlers } = setup();
  const commandCtx = { ...ctx, waitForIdle: async () => { handlers.session_shutdown(); } };
  await expect(commands['desktop-retry-generation-a-settle'].handler(JSON.stringify({ generation: 'generation-a', sessionFile: '/tmp/session.jsonl', token: 'old' }), commandCtx)).rejects.toThrow('could not be confirmed');
});
it('does not register anything outside a Desktop-owned process', () => {
  vi.stubEnv('PI_DESKTOP_GENERATION', ''); const pi = { registerCommand: vi.fn(), on: vi.fn() };
  retryContinuation(pi); expect(pi.on).not.toHaveBeenCalled(); expect(pi.registerCommand).not.toHaveBeenCalled();
});
