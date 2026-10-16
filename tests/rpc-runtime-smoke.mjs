// Offline RPC smoke for the bundled runtime: exercises the RPC commands Desktop
// depends on, plus the events surface. No real model calls, no real sessions on disk.
//
// The version assertion at the top is the point of this script: pi's bundle resolves its own
// package dir from PI_PACKAGE_DIR (see chunk getPackageDir), so without clearing it the bundled
// cli.js silently runs whatever global pi install that variable names and this smoke would
// "pass" against the wrong runtime. Assert first, then test.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-rpc-smoke-'));
const agent = path.join(tmp, 'agent'); fs.mkdirSync(agent);
fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ retry: { enabled: false }, packages: [] }));
fs.writeFileSync(path.join(agent, 'models.json'), JSON.stringify({ providers: { 'offline-smoke': { baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions', apiKey: 'dummy-local-only', models: [{ id: 'smoke', name: 'smoke', reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 64 }] } } }));

const client = new PiRpcClient(process.execPath, [cli, '--mode', 'rpc', '--offline', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-themes', '--provider', 'offline-smoke', '--model', 'smoke'], tmp, childEnv({ PI_CODING_AGENT_DIR: agent, PI_OFFLINE: '1' }));

const events = [];
client.on('event', e => events.push(e));

const results = {};
const check = async (name, fn) => {
  try { results[name] = { ok: true, value: await fn() }; } catch (e) { results[name] = { ok: false, error: String(e?.message ?? e) }; }
};

// 1) get_state
await check('get_state', async () => { const r = await client.request('get_state'); assert.ok(r && typeof r === 'object', 'no state object'); return { keys: Object.keys(r).slice(0, 8) }; });
// 2) get_available_models
await check('get_available_models', async () => { const r = await client.request('get_available_models'); assert.ok(Array.isArray(r?.models ?? r), 'no models array'); return { count: (r?.models ?? r).length }; });
// 3) get_available_thinking_levels
await check('get_available_thinking_levels', async () => { const r = await client.request('get_available_thinking_levels'); const lv = r?.levels ?? r; assert.ok(Array.isArray(lv) && lv.length > 0, 'no levels array'); return { levels: lv }; });
// 4) set_model + get_state readback
await check('set_model', async () => { await client.request('set_model', { provider: 'offline-smoke', modelId: 'smoke' }); const s = await client.request('get_state'); const id = s?.model?.id ?? s?.modelId; assert.equal(id, 'smoke', `set_model did not take: ${id}`); return { model: id }; });
// 5) set_thinking_level + get_state readback (assert the readback, not just the ack)
await check('set_thinking_level', async () => { await client.request('set_thinking_level', { level: 'high' }); const st = await client.request('get_state'); assert.equal(st?.thinkingLevel, 'high', `thinking level not applied: ${st?.thinkingLevel}`); return { thinking: st?.thinkingLevel }; });
// 6) get_entries (incremental contract)
await check('get_entries', async () => { const r = await client.request('get_entries'); const e = r?.entries ?? r; assert.ok(Array.isArray(e), 'no entries array'); return { entries: e.length }; });
// 7) get_session_stats (assert the fields Desktop actually reads, not just object-ness)
await check('get_session_stats', async () => { const r = await client.request('get_session_stats'); assert.ok(r && typeof r === 'object', 'no stats object'); for (const k of ['sessionId', 'userMessages', 'assistantMessages']) assert.ok(k in r, `session_stats missing ${k}`); return { keys: Object.keys(r).slice(0, 6) }; });
// 8) set_session_name + readback via get_state (no dedicated readback RPC exists)
await check('set_session_name', async () => { await client.request('set_session_name', { name: 'rpc-smoke' }); const s = await client.request('get_state'); assert.equal(s?.sessionName, 'rpc-smoke', `session name not applied: ${s?.sessionName}`); return { sessionName: s?.sessionName }; });

await new Promise(r => setTimeout(r, 400));
client.close?.() ?? client.dispose?.();

const failed = Object.entries(results).filter(([, v]) => !v.ok);
console.log(JSON.stringify({ results, eventCount: events.length, eventTypes: [...new Set(events.map(e => e.type))].slice(0, 12) }, null, 1));
fs.rmSync(tmp, { recursive: true, force: true });
assert.equal(failed.length, 0, `RPC smoke failures: ${failed.map(([k, v]) => `${k}=${v.error}`).join('; ')}`);
console.log('RPC SMOKE OK (bundled runtime, offline)');
