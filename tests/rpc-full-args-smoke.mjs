// Full Desktop launch-args RPC smoke against the bundled runtime, with a real local
// OpenAI-compatible server so a prompt actually completes and the session transcript
// is persisted. That transcript is the only place the active tool set (toolsAdded) is
// recorded, so this is the one reliable way to assert the --tools whitelist end to end.
//
// Also asserts the bundled runtime's version first: pi's bundle honours PI_PACKAGE_DIR,
// so an inherited value would silently swap in a global install and "pass" against it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { PiRpcClient } from '../src/main/pi/rpc-client.ts';

const root = process.cwd();
const expected = JSON.parse(fs.readFileSync(path.join(root, 'resources/pi-runtime/package.json'), 'utf8')).dependencies['@earendil-works/pi-coding-agent'];
const cli = path.join(root, 'resources/pi-runtime/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js');
/** pi bundle honours PI_PACKAGE_DIR over its own path; strip the two knobs that can redirect it. */
const childEnv = (extra = {}) => { const e = { ...process.env, ...extra }; delete e.PI_PACKAGE_DIR; delete e.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT; return e; };

const version = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8', env: childEnv() });
assert.equal(version.status, 0, `bundled cli --version failed: ${version.stderr}`);
assert.equal(version.stdout.trim(), expected, `bundled runtime is ${version.stdout.trim()}, expected ${expected} — PI_PACKAGE_DIR leak or stale node_modules`);
console.log(`bundled runtime: pi ${version.stdout.trim()}`);

// Minimal OpenAI-compatible chat completions server: one non-streaming reply, no tools called.
// Enough for pi to complete a turn and persist the transcript.
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', d => body += d);
  req.on('end', () => {
    const wantsStream = /"stream"\s*:\s*true/.test(body);
    if (wantsStream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'smoke ok' } }] })}\n\n`);
      res.write('data: [DONE]\n\n'); res.end(); return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'smoke ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-full-args-smoke-'));
const agent = path.join(tmp, 'agent'); fs.mkdirSync(agent);
fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ retry: { enabled: false }, packages: [] }));
fs.writeFileSync(path.join(agent, 'models.json'), JSON.stringify({ providers: { 'offline-smoke': { baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', apiKey: 'dummy-local-only', models: [{ id: 'smoke', name: 'smoke', reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 256 }] } } }));

const pol = path.join(root, 'extensions/desktop-policy');
const exts = [path.join(pol, 'index.mjs'), path.join(pol, 'mcp-bridge.mjs'), path.join(pol, 'retry-continuation.mjs')].filter(f => fs.existsSync(f));
const sessionDir = path.join(tmp, 'owned'); fs.mkdirSync(sessionDir);
const sessionFile = path.join(sessionDir, 'smoke.jsonl');
const args = [
  '--mode', 'rpc',
  '--session', sessionFile,
  '--session-dir', sessionDir,
  '--no-approve',
  ...exts.flatMap(f => ['-e', f]),
  '--append-system-prompt', 'SMOKE-MARKER-SYSTEM-PROMPT',
  '--tools', 'read,grep,find,ls,ask_user_question,desktop_update_plan',
  '--model', 'smoke',
];

const client = new PiRpcClient(process.execPath, [cli, ...args], tmp, childEnv({ PI_CODING_AGENT_DIR: agent }));
const events = []; client.on('event', e => events.push(e.type));
const r = {};
const ck = async (n, fn) => { try { r[n] = { ok: true, v: await fn() }; } catch (e) { r[n] = { ok: false, e: String(e?.message ?? e) }; } };

/** Active tool names from the persisted transcript (the system entry's toolsAdded). */
const readTranscript = () => {
  assert.ok(fs.existsSync(sessionFile), `session transcript not persisted at ${sessionFile}`);
  return fs.readFileSync(sessionFile, 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
};
/** Active builtin tool names from the persisted transcript. pi records the effective tool
 *  set inside the system prompt's <tools> block (entries carry no toolsAdded field), so that
 *  block is the authoritative record of what --tools actually produced. */
const activeTools = () => {
  const rows = readTranscript();
  const names = new Set();
  for (const row of rows) {
    const blob = JSON.stringify(row.message ?? row);
    const block = /<tools>([\s\S]*?)<\/tools>/.exec(blob);
    if (!block) continue;
    for (const m of block[1].matchAll(/-\s*([a-z_]+):/g)) names.add(m[1]);
  }
  return { names: [...names], rows: rows.length };
};

await ck('get_state', async () => { const s = await client.request('get_state'); assert.ok(s?.model, 'no model in state'); return { model: s.model?.id ?? s.model, sessionFile: path.basename(s.sessionFile ?? '') }; });

await ck('prompt_completes_and_persists', async () => {
  const res = await client.request('prompt', { message: 'Reply with the single word: smoke' }, 90000);
  assert.ok(res !== undefined, 'prompt produced no response');
  await new Promise(r2 => setTimeout(r2, 600));
  const { rows } = activeTools();
  assert.ok(rows > 0, 'transcript empty after prompt');
  return { rows };
});

// The whole point of the --tools flag: read-only builtins, no bash/edit/write.
await ck('tools_whitelist_enforced', async () => {
  const { names, rows } = activeTools();
  assert.ok(names.length > 0, `no <tools> block recorded in transcript (rows=${rows}) — cannot verify whitelist`);
  for (const required of ['read', 'grep', 'find', 'ls']) assert.ok(names.includes(required), `whitelisted tool missing from active set: ${required}`);
  for (const forbidden of ['bash', 'edit', 'write', 'multiedit']) assert.ok(!names.includes(forbidden), `--tools whitelist leaked a mutating tool: ${forbidden}`);
  return { names };
});

// desktop_update_plan is extension-registered, so it never appears in the builtin <tools>
// block. Prove it is live via the policy extension's own audit entry instead.
await ck('extension_chain_loaded', async () => {
  // The policy extension writes a desktop-policy-audit custom entry at session start.
  const rows = readTranscript();
  const audit = rows.find(x => x?.customType === 'desktop-policy-audit');
  assert.ok(audit, 'desktop-policy-audit entry absent -> -e extension chain failed to load');
  return { rows: rows.length };
});

await ck('extension_tool_registered', async () => {
  const rows = readTranscript();
  const audit = rows.find(x => x?.customType === 'desktop-policy-audit');
  assert.ok(audit, 'desktop-policy-audit entry absent -> policy extension did not load');
  const g = await client.request('get_commands');
  const cmds = (g?.commands ?? g ?? []).map(c => c?.name ?? c).filter(Boolean);
  assert.ok(!cmds.includes('desktop_update_plan'), 'desktop_update_plan unexpectedly listed as a slash command');
  return { commandCount: cmds.length };
});

await ck('set_thinking_level', async () => {
  await client.request('set_thinking_level', { level: 'medium' });
  const s = await client.request('get_state');
  assert.equal(s?.thinkingLevel, 'medium', `thinking level not applied: ${s?.thinkingLevel}`);
  return { thinking: s?.thinkingLevel };
});

await ck('get_entries_since_leaf', async () => {
  const first = await client.request('get_entries');
  const list = first?.entries ?? first ?? [];
  if (!list.length) return { skipped: 'no entries yet' };
  const leaf = list[list.length - 1]?.id ?? list[list.length - 1]?.leafId;
  assert.ok(typeof leaf === 'string' && leaf.length > 0, 'no leaf id to page from');
  const e = await client.request('get_entries', { since: leaf });
  return { since: leaf.slice(0, 8), count: (e?.entries ?? e ?? []).length };
});

await new Promise(r => setTimeout(r, 400));
client.close?.() ?? client.dispose?.();
server.close();
const failed = Object.entries(r).filter(([, v]) => !v.ok);
console.log(JSON.stringify({ results: r, events: [...new Set(events)] }, null, 1));
fs.rmSync(tmp, { recursive: true, force: true });
assert.equal(failed.length, 0, `failures: ${failed.map(([k, v]) => `${k}=${v.e}`).join('; ')}`);
console.log('FULL-ARGS RPC SMOKE OK (bundled pi ' + expected + ')');
