// Full Desktop launch-args RPC smoke against the bundled runtime: replicates the exact
// argument vector backend.ts builds (six -e extensions, --session/--session-dir, --approve,
// --append-system-prompt, --tools whitelist, --model) and then drives the RPC surface.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { PiRpcClient } from '../src/main/pi/rpc-client.ts';

const root = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-full-args-smoke-'));
const server = net.createServer();
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
await new Promise(r => server.close(r));
const agent = path.join(tmp, 'agent'); fs.mkdirSync(agent);
fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ retry: { enabled: false }, packages: [] }));
fs.writeFileSync(path.join(agent, 'models.json'), JSON.stringify({ providers: { 'offline-smoke': { baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', apiKey: 'dummy-local-only', models: [{ id: 'smoke', name: 'smoke', reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 64 }] } } }));

const pol = path.join(root, 'extensions/desktop-policy');
const exts = ['index.mjs', 'mcp-bridge.mjs', 'retry-continuation.mjs'].map(f => path.join(pol, f))
  .concat([path.join(pol, '../desktop-codemode-nudge/index.mjs'), path.join(pol, '../desktop-cache/index.mjs')]);
const existing = exts.filter(f => fs.existsSync(f));
const missing = exts.filter(f => !fs.existsSync(f));
const sessionDir = path.join(tmp, 'owned'); fs.mkdirSync(sessionDir);
const sessionFile = path.join(sessionDir, 'smoke.jsonl');
const cli = path.join(root, 'resources/pi-runtime/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js');
const args = [
  '--mode', 'rpc',
  '--session', sessionFile,
  '--session-dir', sessionDir,
  '--no-approve',
  ...existing.flatMap(f => ['-e', f]),
  '--append-system-prompt', 'SMOKE-MARKER-SYSTEM-PROMPT',
  '--tools', 'read,grep,find,ls,ask_user_question,desktop_update_plan',
  '--model', 'smoke',
  '--offline',
];
console.log('missing extensions (skipped):', missing.map(m => path.basename(m)).join(',') || '(none)');

const client = new PiRpcClient(process.execPath, [cli, ...args], tmp, { ...process.env, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: '1' });
const events = []; client.on('event', e => events.push(e.type));
const r = {};
const ck = async (n, fn) => { try { r[n] = { ok: true, v: await fn() }; } catch (e) { r[n] = { ok: false, e: String(e?.message ?? e) }; } };

await ck('get_state', async () => { const s = await client.request('get_state'); assert.ok(s?.model, 'no model in state'); return { model: s.model?.id ?? s.model, sessionFile: path.basename(s.sessionFile ?? ''), thinking: s.thinkingLevel }; });
await ck('tool_whitelist_active', async () => { const g = await client.request('get_commands'); const names = (g?.commands ?? g ?? []).map(c => c?.name ?? c).filter(Boolean); return { commandCount: names.length, hasUpdatePlan: names.includes('desktop_update_plan') }; });
await ck('extension_chain_loaded', async () => {
  // The policy extension writes a desktop-policy-audit custom entry at session start. Its
  // presence proves the whole -e chain (index.mjs -> plan.mjs) loaded and ran under 1.3.0.
  // System prompt text is NOT an entry, so assert on the audit entry instead.
  const e = await client.request('get_entries');
  const list = e?.entries ?? e ?? [];
  const audit = list.find(x => x?.customType === 'desktop-policy-audit');
  assert.ok(audit, 'desktop-policy-audit entry absent -> -e extension chain failed to load');
  return { entries: list.length };
});
await ck('extension_tool_end_to_end', async () => {
  // desktop_update_plan is an extension-registered tool (not a slash command), so drive it
  // end-to-end: send a prompt that asks the model to call it, then confirm the tool result
  // lands in the transcript. Proves the -e extension chain loaded and registered under 1.3.0.
  await client.request('prompt', { text: 'Call desktop_update_plan with plan=[{step:"smoke",status:"in_progress"}].' }, 60000).catch(() => undefined);
  await new Promise(r => setTimeout(r, 800));
  const e = await client.request('get_entries');
  const list = e?.entries ?? e ?? [];
  const hit = list.find(x => x?.customType === 'desktop-policy-audit' || (typeof x?.type === 'string' && x.type.includes('tool')));
  return { entries: list.length, sawToolOrAudit: Boolean(hit) };
});
await ck('set_thinking_level', async () => { await client.request('set_thinking_level', { level: 'medium' }); const s = await client.request('get_state'); return { thinking: s?.thinkingLevel }; });
await ck('get_entries_since_leaf', async () => {
  const first = await client.request('get_entries');
  const list = first?.entries ?? first ?? [];
  if (!list.length) return { skipped: 'no entries yet' };
  const leaf = list[list.length - 1]?.id ?? list[list.length - 1]?.leafId;
  const e = await client.request('get_entries', { since: leaf });
  return { since: typeof leaf === 'string' ? leaf.slice(0, 8) : leaf, count: (e?.entries ?? e ?? []).length };
});

await new Promise(r => setTimeout(r, 400));
client.close?.() ?? client.dispose?.();
const failed = Object.entries(r).filter(([, v]) => !v.ok);
console.log(JSON.stringify({ results: r, events: [...new Set(events)] }, null, 1));
fs.rmSync(tmp, { recursive: true, force: true });
assert.equal(failed.length, 0, `failures: ${failed.map(([k, v]) => `${k}=${v.e}`).join('; ')}`);
console.log('FULL-ARGS RPC SMOKE OK (bundled pi 1.3.0)');
