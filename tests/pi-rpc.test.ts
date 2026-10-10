import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PiRpcClient } from '../src/main/pi/rpc-client';
import { PiBackend } from '../src/main/pi/backend';
import { SessionIndex } from '../src/main/pi/session-index';
import type { PiEvent, PiUiRequest } from '../src/shared/pi';
const clients:PiRpcClient[]=[];
const client=()=>{const c=new PiRpcClient(process.execPath,[path.resolve('tests/fixtures/fake-pi.mjs')],process.cwd(),process.env);clients.push(c);return c;};
const roots: string[] = [], backends: PiBackend[] = [];
afterEach(() => {
 backends.splice(0).forEach(b => b.dispose());
 clients.splice(0).forEach(c => c.close());
 roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }));
});
describe('pi RPC framing and lifecycle',()=>{
 it('correlates out-of-order replies',async()=>{const c=client();expect(await Promise.all([c.request('echo',{value:'first',delay:40}),c.request('echo',{value:'second'})])).toEqual(['first','second']);});
 it('preserves UTF-8 and Unicode line separators',async()=>expect(await client().request('unicode')).toBe('中文\u2028\u2029'));
 it('ignores non-protocol stdout without failing valid replies',async()=>expect(await client().request('noise')).toBe('fine'));
 it('rejects command errors and times out without replay',async()=>{const c=client();await expect(c.request('bad')).rejects.toThrow('unsupported');await expect(c.request('never',{},50)).rejects.toThrow('超时');});
 it('settles every pending promise when process exits',async()=>{const c=client();const waiting=c.request('never');const exiting=c.request('exit');await expect(waiting).rejects.toThrow('退出');await expect(exiting).rejects.toThrow('退出');});
});

const askQuestion = { header: 'First', question: 'Choose a direction?', multiSelect: false, options: [{ label: 'Alpha', description: 'A' }, { label: 'Beta', description: 'B' }] };
async function askBackend(thirdParty = true) {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-rpc-')); roots.push(root);
 const owned = path.join(root, 'desktop'); fs.mkdirSync(owned);
 if (thirdParty) {
  const pkg = path.join(root, 'npm/node_modules/@juicesharp/rpiv-ask-user-question');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@juicesharp/rpiv-ask-user-question', pi: { extensions: ['index.ts'] } }));
 }
 const events: PiEvent[] = [];
 const backend = new PiBackend({ executable: process.execPath, supported: true, agentDir: root, sessionDirs: [root], diagnostics: [] }, new SessionIndex([owned], owned), owned, path.resolve('extensions/desktop-policy/index.mjs'), event => events.push(structuredClone(event)));
 backends.push(backend);
 let rpc!: PiRpcClient, launchArgs: string[] = [];
 backend.clientFactory = (_command, args, cwd, env) => {
  launchArgs = args;
  rpc = new PiRpcClient(process.execPath, [path.resolve('tests/fixtures/fake-pi.mjs'), ...args], cwd, env);
  return rpc;
 };
 const run = await backend.connect({ cwd: root, trustProject: false, permission: 'ask' });
 const dialogs = () => events.flatMap(e => e.type === 'ui' && ['select', 'input', 'confirm'].includes(e.request.method) ? [e.request] : []);
 const start = async (questions: typeof askQuestion[], extra: Record<string, unknown> = {}) => {
  await rpc.request('ask_scenario', { questions, ...extra });
  await vi.waitFor(() => expect(dialogs().length).toBeGreaterThan(0));
  return dialogs().at(-1)!;
 };
 const respond = (request: PiUiRequest, answers: string[][]) => backend.respond(run.key, run.generation, { id: request.id, value: JSON.stringify(answers.map((a, i) => ({ header: `question-${i}`, answers: a }))) });
 const responses = () => rpc.request('ask_responses') as Promise<Array<{ id: string; value?: string; cancelled?: boolean }>>;
 return { backend, run, rpc, launchArgs, events, dialogs, start, respond, responses };
}

describe('third-party ask coexistence RPC bridge', () => {
 it('omits desktop-ask for scoped autoload packages and answers later questions without more UI', async () => {
  const b = await askBackend();
  expect(b.launchArgs).not.toContain(path.resolve('extensions/desktop-ask/index.mjs'));
  const questions = [askQuestion, { ...askQuestion, header: 'Second', multiSelect: true }];
  const request = await b.start(questions);
  expect(request).toMatchObject({ id: 'ask-third-party-ask-0', method: 'input', title: 'desktop-ask' });
  expect(JSON.parse(request.placeholder!)).toMatchObject({ questions });
  expect(b.backend.pendingDialogs(b.run.key)).toEqual([{ generation: b.run.generation, request }]);
  b.respond(request, [['Beta'], ['Alpha', 'Beta']]);
  await vi.waitFor(async () => expect((await b.responses()).map(r => r.value)).toEqual(['2', '1,2']));
  expect(b.dialogs()).toHaveLength(1);
  expect(b.backend.pendingDialogs(b.run.key)).toEqual([]);
  for (const id of ['ask-third-party-ask-0', 'ask-third-party-ask-1']) {
   expect(b.events.some(e => e.type === 'rpc' && e.event.type === 'ui-resolved' && e.event.id === id)).toBe(true);
  }
 });
 it('keeps the desktop fallback and native UI behavior when no third-party ask is present', async () => {
  const b = await askBackend(false);
  expect(b.launchArgs).toContain(path.resolve('extensions/desktop-ask/index.mjs'));
  const request = await b.start([askQuestion]);
  expect(request).toMatchObject({ method: 'select', title: askQuestion.question });
  b.backend.respond(b.run.key, b.run.generation, { id: request.id, value: '1' });
  await vi.waitFor(async () => expect((await b.responses())[0]?.value).toBe('1'));
 });
 it('handles sentinel custom input in both the first and later questions, followed by an empty multi commit', async () => {
  const b = await askBackend();
  const request = await b.start([askQuestion, { ...askQuestion, header: 'Second' }, { ...askQuestion, header: 'Third', multiSelect: true }]);
  b.respond(request, [['custom first'], ['custom second'], []]);
  await vi.waitFor(async () => expect((await b.responses()).map(r => r.value)).toEqual(['3', 'custom first', '3', 'custom second', '']));
  expect(b.dialogs()).toHaveLength(1);
  // Completion clears the bridge: a later unrelated input must not be auto-answered.
  await b.rpc.request('emit_events', { events: [{ type: 'extension_ui_request', id: 'unrelated', method: 'input', title: 'Other tool' }] });
  await vi.waitFor(() => expect(b.dialogs().at(-1)?.title).toBe('Other tool'));
 });
 it('rejects malformed card replies without losing the pending dialog, then supports cancellation', async () => {
  const b = await askBackend(); const request = await b.start([askQuestion]);
  for (const value of ['not JSON', '[{"answers":1}]', '[]']) {
   expect(() => b.backend.respond(b.run.key, b.run.generation, { id: request.id, value })).toThrow('格式无效');
   expect(b.backend.pendingDialogs(b.run.key)).toHaveLength(1);
  }
  b.backend.respond(b.run.key, b.run.generation, { id: request.id, cancelled: true });
  await vi.waitFor(async () => expect(await b.responses()).toEqual([{ type: 'extension_ui_response', id: request.id, cancelled: true }]));
  expect(b.backend.pendingDialogs(b.run.key)).toEqual([]);
 });
 it('stops a pending card and clears its bridge before a new questionnaire', async () => {
  const b = await askBackend(); const request = await b.start([askQuestion]);
  await b.backend.stop(b.run.key);
  expect(b.backend.pendingDialogs(b.run.key)).toEqual([]);
  expect(() => b.respond(request, [['Alpha']])).toThrow('过期');
  await vi.waitFor(async () => expect((await b.responses())[0]?.cancelled).toBe(true));
  const next = await b.start([askQuestion], { callId: 'next' });
  b.respond(next, [['Alpha']]);
  await vi.waitFor(async () => expect((await b.responses())[0]?.value).toBe('1'));
 });
 it('passes through oversized questionnaires unchanged', async () => {
  const b = await askBackend();
  const request = await b.start(Array.from({ length: 5 }, () => askQuestion));
  expect(request).toMatchObject({ method: 'select', title: askQuestion.question });
  b.backend.respond(b.run.key, b.run.generation, { id: request.id, cancelled: true });
 });
 it('clears an unconsumed stash on matching tool end, not unrelated tool ends', async () => {
  const b = await askBackend();
  await b.rpc.request('ask_scenario', { questions: [askQuestion], noUi: true });
  await b.rpc.request('emit_events', { events: [{ type: 'extension_ui_request', id: 'after-validation', method: 'input', title: 'Native input' }] });
  await vi.waitFor(() => expect(b.dialogs().at(-1)?.title).toBe('Native input'));
  b.backend.respond(b.run.key, b.run.generation, { id: 'after-validation', cancelled: true });
  await b.rpc.request('emit_events', { events: [
   { type: 'tool_execution_start', toolName: 'ask_user_question', toolCallId: 'pending', args: { questions: [askQuestion] } },
   { type: 'tool_execution_end', toolName: 'ask_user_question', toolCallId: 'unrelated' },
   { type: 'extension_ui_request', id: 'pending-ui', method: 'select', title: 'Native select' },
  ] });
  await vi.waitFor(() => expect(b.dialogs().at(-1)?.title).toBe('desktop-ask'));
  await b.rpc.request('emit_events', { events: [{ type: 'tool_execution_end', toolCallId: 'pending' }] });
  await vi.waitFor(() => expect(b.backend.pendingDialogs(b.run.key)).toEqual([]));
 });
 it('bridges a questionnaire whose first native request is a multi-select input', async () => {
  const b = await askBackend();
  const request = await b.start([{ ...askQuestion, multiSelect: true }, askQuestion]);
  expect(request).toMatchObject({ method: 'input', title: 'desktop-ask' });
  b.respond(request, [['custom multi'], []]);
  await vi.waitFor(async () => expect((await b.responses()).map(r => r.value)).toEqual(['custom multi', '3', '']));
  expect(b.dialogs()).toHaveLength(1);
 });
 it('automatically cancels residual requests until the matching tool ends', async () => {
  const b = await askBackend(); const send = vi.spyOn(b.rpc, 'send');
  await b.rpc.request('emit_events', { events: [
   { type: 'tool_execution_start', toolName: 'ask_user_question', toolCallId: 'cancelled-ask', args: { questions: [askQuestion] } },
   { type: 'extension_ui_request', id: 'cancelled-ui', method: 'select' },
  ] });
  await vi.waitFor(() => expect(b.dialogs().at(-1)?.title).toBe('desktop-ask'));
  b.backend.respond(b.run.key, b.run.generation, { id: 'cancelled-ui', cancelled: true });
  await b.rpc.request('emit_events', { events: [
   { type: 'extension_ui_request', id: 'residual', method: 'input' },
   { type: 'tool_execution_end', toolCallId: 'cancelled-ask' },
   { type: 'extension_ui_request', id: 'after-cancel', method: 'input', title: 'Other input' },
  ] });
  await vi.waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'extension_ui_response', id: 'residual', cancelled: true }));
  expect(b.dialogs().map(r => r.id)).toEqual(['cancelled-ui', 'after-cancel']);
  expect(b.events.some(e => e.type === 'rpc' && e.event.type === 'ui-resolved' && e.event.id === 'residual')).toBe(true);
 });
 it('discards a pending questionnaire on close and rejects replies to that generation', async () => {
  const b = await askBackend(); const request = await b.start([askQuestion]);
  b.backend.close(b.run.key);
  expect(b.backend.pendingDialogs(b.run.key)).toEqual([]);
  expect(b.backend.runs()).toEqual([]);
  expect(() => b.respond(request, [['Alpha']])).toThrow('未由 Desktop 连接');
 });
 it('preserves native timeout and rejects responses after the synthesized card expires', async () => {
  const b = await askBackend(); const request = await b.start([askQuestion], { timeout: 150 });
  expect(request.timeout).toBe(150);
  await vi.waitFor(() => expect(b.backend.pendingDialogs(b.run.key)).toEqual([]));
  expect(() => b.respond(request, [['Alpha']])).toThrow('过期');
 });
 it('a cancelled bridge residue must not swallow the first request of a new questionnaire', async () => {
  const b = await askBackend();
  // 旧问卷卡片取消；不发 tool_execution_end（模拟 in-process subagent 收尾挂起），桥以 cancelled 残留。
  await b.rpc.request('emit_events', { events: [
   { type: 'tool_execution_start', toolName: 'ask_user_question', toolCallId: 'old-ask', args: { questions: [askQuestion] } },
   { type: 'extension_ui_request', id: 'old-ui', method: 'select' },
  ] });
  await vi.waitFor(() => expect(b.dialogs().at(-1)?.title).toBe('desktop-ask'));
  b.backend.respond(b.run.key, b.run.generation, { id: 'old-ui', cancelled: true });
  // 新问卷：旧 cancelled 桥必须被丢弃，新请求合成新卡片而非被自动 cancelled。
  const next = await b.start([{ ...askQuestion, header: 'New' }], { callId: 'new-ask' });
  expect(next).toMatchObject({ method: 'input', title: 'desktop-ask' });
  b.respond(next, [['Alpha']]);
  await vi.waitFor(async () => expect((await b.responses())[0]?.value).toBe('1'));
 });
 it('passes an interleaved native request through while the card is unanswered', async () => {
  const b = await askBackend(); const send = vi.spyOn(b.rpc, 'send');
  const request = await b.start([askQuestion], { callId: 'ask-1' });
  // 卡片未答时插入无关请求：fail-open 放行为原生对话框，不被桥吞掉。
  await b.rpc.request('emit_events', { events: [{ type: 'extension_ui_request', id: 'other-ui', method: 'input', title: 'Other tool' }] });
  await vi.waitFor(() => expect(b.dialogs().map(r => r.title)).toEqual(['desktop-ask', 'Other tool']));
  // 卡片应答仍走桥接分支；无关对话框走通用分支独立应答。
  b.respond(request, [['Alpha']]);
  b.backend.respond(b.run.key, b.run.generation, { id: 'other-ui', value: 'native-answer' });
  await vi.waitFor(async () => expect((await b.responses())[0]?.value).toBe('1'));
  expect(send).toHaveBeenCalledWith({ type: 'extension_ui_response', id: 'other-ui', value: 'native-answer' });
 });
});
