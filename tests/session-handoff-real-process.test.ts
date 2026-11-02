import {it, expect} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn, spawnSync} from 'node:child_process';
import {PiBackend} from '../src/main/pi/backend';
import {PiRpcClient} from '../src/main/pi/rpc-client';
import {SessionIndex} from '../src/main/pi/session-index';
import {sessionKey} from '../node_modules/@wengine-ai/pi-session-handoff/index.mjs';

const root = process.cwd();
const cli = process.env.PI_HANDOFF_TEST_CLI || path.join(root, 'resources/pi-runtime/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js');
const extensions = process.env.PI_HANDOFF_TEST_EXTENSIONS || path.join(root, 'extensions');
const plugin = path.join(root, 'node_modules/@wengine-ai/pi-session-handoff');
const cleanEnv = extra => {const env = {...process.env, ...extra}; delete env.PI_PACKAGE_DIR; delete env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT; return env;};
async function until(fn, message = 'condition', timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {const value = await fn(); if (value) return value; await new Promise(r => setTimeout(r, 25));}
  throw new Error('Timed out: ' + message);
}
function rpc(args, cwd, agent) {
  const child = spawn(process.execPath, [cli, '--mode', 'rpc', '--no-approve', ...args], {cwd, env: cleanEnv({PI_CODING_AGENT_DIR: agent}), stdio: ['pipe', 'pipe', 'pipe']});
  const events: any[] = []; let buffer = '', stderr = ''; let sequence = 0;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk; let at;
    while ((at = buffer.indexOf('\n')) >= 0) {const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); try {events.push(JSON.parse(line));} catch { /* diagnosed by timeout */ }}
  });
  child.stderr.on('data', chunk => {stderr += chunk;});
  return {
    events,
    async request(type, data = {}) {
      const id = 'request-' + ++sequence; child.stdin.write(JSON.stringify({type, id, ...data}) + '\n');
      const response = await until(() => events.find(e => e.type === 'response' && e.id === id), type + ': ' + stderr.slice(-500));
      if (!response.success) throw new Error(response.error); return response.data;
    },
    async close() {
      if (child.exitCode !== null) return;
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
      child.stdin.end();
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      try {await exited;} finally {clearTimeout(timer);}
    },
  };
}

it('real pi model tool calls deliver both ways through Desktop backend, queue while busy, dedupe and retire on reload/close', async () => {
  const version = spawnSync(process.execPath, [cli, '--version'], {env: cleanEnv({}), encoding: 'utf8'});
  expect(version.status).toBe(0); expect(version.stdout.trim()).toBe('1.4.0');
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-e2e-')));
  const agent = path.join(tmp, 'agent'), a = path.join(tmp, 'project-a'), b = path.join(tmp, 'project-b');
  for (const dir of [agent, a, b]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({packages: [plugin], defaultProvider: 'local-proof', defaultModel: 'proof', retry: {enabled: false}, compaction: {enabled: false}}));
  const requests: any[] = []; let held: any;
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    const last = body.messages.at(-1);
    const text = typeof last?.content === 'string' ? last.content : (last?.content || []).map(x => x.text || '').join('');
    const finish = () => {
      res.writeHead(200, {'content-type': 'text/event-stream'});
      const delta = text.startsWith('CALL_HANDOFF ')
        ? {role: 'assistant', tool_calls: [{index: 0, id: 'handoff-' + requests.length, type: 'function', function: {name: 'session_handoff', arguments: text.slice(13)}}]}
        : {role: 'assistant', content: 'proof completed'};
      const send = (d, reason) => res.write('data: ' + JSON.stringify({id: 'proof', object: 'chat.completion.chunk', created: 1, model: 'proof', choices: [{index: 0, delta: d, finish_reason: reason}]}) + '\n\n');
      send(delta, null); send({}, delta.tool_calls ? 'tool_calls' : 'stop'); res.end('data: [DONE]\n\n');
    };
    if (text === 'HOLD_BUSY') held = finish; else finish();
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  fs.writeFileSync(path.join(agent, 'models.json'), JSON.stringify({providers: {'local-proof': {baseUrl: 'http://127.0.0.1:' + (server.address() as any).port + '/v1', api: 'openai-completions', apiKey: 'local-only', models: [{id: 'proof', name: 'proof', input: ['text'], contextWindow: 32000, maxTokens: 1000}]}}}));
  const owned = path.join(agent, 'sessions/desktop'); fs.mkdirSync(owned, {recursive: true});
  const index = new SessionIndex([owned], owned); const desktopEvents: any[] = [];
  const backend = new PiBackend({executable: process.execPath, launchArgs: [cli], supported: true, version: '1.4.0', agentDir: agent, sessionDirs: [owned], diagnostics: []}, index, owned, path.join(extensions, 'desktop-policy/index.mjs'), e => desktopEvents.push(e));
  backend.clientFactory = (command, args, cwd, env) => new PiRpcClient(command, args, cwd, cleanEnv(env));
  const file = path.join(a, 'tui.jsonl');
  const sender = rpc(['--session', file, '--session-dir', a, '--model', 'local-proof/proof', '-e', path.join(root, 'tests/fixtures/handoff-lifecycle.mjs')], a, agent);
  const registry = path.join(agent, 'handoff/descriptors');
  const descriptors = () => fs.existsSync(registry) ? fs.readdirSync(registry).filter(n => n.endsWith('.json')).map(n => JSON.parse(fs.readFileSync(path.join(registry, n), 'utf8'))) : [];
  let desktop;
  try {
    await sender.request('get_state');
    desktop = await backend.connect({cwd: b, trustProject: false, permission: 'ask', model: 'local-proof/proof'});
    await until(() => descriptors().length === 2, 'both descriptors');
    const target = descriptors().find(d => d.cwd === b); expect(target).toBeTruthy();
    const command = args => 'CALL_HANDOFF ' + JSON.stringify(args);
    async function toolCall(args) {
      const from = sender.events.length;
      await sender.request('prompt', {message: command(args)});
      const end = await until(() => sender.events.slice(from).find(e => e.type === 'tool_execution_end' && e.toolName === 'session_handoff'), 'real model tool execution');
      expect(end.isError).toBeFalsy();
      await until(() => sender.events.slice(from).some(e => e.type === 'agent_settled'), 'sender idle');
      return end.result.details;
    }
    const list = await toolCall({action: 'list', projectPath: b});
    expect(list.sessions.map(s => s.key)).toContain(target.sessionKey);
    const payload = {action: 'send', projectPath: b, sessionKey: target.sessionKey, message: 'E2E_IDLE_MESSAGE', idempotencyKey: 'idle'};
    expect(await toolCall(payload)).toMatchObject({ok: true, disposition: 'started'});
    await until(() => desktopEvents.some(e => e.type === 'rpc' && JSON.stringify(e).includes('E2E_IDLE_MESSAGE')), 'Desktop receives actual turn');
    expect(await toolCall(payload)).toMatchObject({ok: true, duplicate: true});
    await until(() => backend.runs()[0].status === 'idle', 'Desktop idle');
    await backend.prompt(desktop.key, 'HOLD_BUSY', 'followUp');
    await until(() => held, 'held model request');
    expect(await toolCall({...payload, message: 'E2E_BUSY_MESSAGE', idempotencyKey: 'busy'})).toMatchObject({ok: true, disposition: 'queued'});
    const receivedBusy = () => requests.some(r => r.messages.some(m => m.role === 'user' && JSON.stringify(m.content).includes('交接内容开始') && JSON.stringify(m.content).includes('E2E_BUSY_MESSAGE')));
    expect(receivedBusy()).toBe(false);
    held(); held = undefined;
    await until(receivedBusy, 'queued turn begins after busy completes');
    await until(() => backend.runs()[0].status === 'idle', 'queue settled');
    // The reverse path uses the real Desktop permission extension and backend event flow.
    await backend.prompt(desktop.key, command({action: 'send', projectPath: a, sessionKey: sessionKey(file), message: 'E2E_REVERSE_MESSAGE', idempotencyKey: 'reverse'}), 'followUp');
    const approval = await until(() => desktopEvents.find(e => e.type === 'ui' && e.request.method === 'select' && e.request.title.includes('session_handoff')), 'Desktop asks permission for reverse handoff');
    backend.respond(desktop.key, desktop.generation, {id: approval.request.id, value: '允许'});
    await until(() => sender.events.some(e => e.type === 'message_end' && e.message?.role === 'user' && JSON.stringify(e).includes('E2E_REVERSE_MESSAGE')), 'reverse delivery to external pi');
    await until(() => backend.runs()[0].status === 'idle', 'reverse settled');
    const transcript = fs.readFileSync(desktop.file, 'utf8');
    const rows = transcript.trim().split('\n').map(line => JSON.parse(line));
    expect(rows.filter(r => r.message?.role === 'user' && JSON.stringify(r.message).includes('E2E_IDLE_MESSAGE'))).toHaveLength(1);
    expect(transcript).toContain('E2E_BUSY_MESSAGE');
    expect(backend.runs()[0].accessMode).toBe('ask');
    expect(backend.sessionContext(desktop.key)?.cwd).toBe(b);
    expect(requests.some(r => r.tools?.some(t => t.function?.name === 'session_handoff'))).toBe(true);
    const old = descriptors().find(d => d.cwd === a);
    await sender.request('prompt', {message: '/proof-reload'});
    await until(() => descriptors().some(d => d.cwd === a && d.instanceId !== old.instanceId), 'reload replaces descriptor');
    await sender.close();
    await until(() => !descriptors().some(d => d.cwd === a), 'shutdown removes descriptor');
    const proof = {runtime: version.stdout.trim(), requests: requests.length, bidirectional: true, queued: true, duplicate: true, reload: true, source: cli};
    fs.mkdirSync('/tmp/pi-handoff-plugin-proof', {recursive: true});
    fs.writeFileSync('/tmp/pi-handoff-plugin-proof/real-process-result.json', JSON.stringify(proof, null, 2));
  } finally {
    held?.(); await sender.close(); backend.dispose(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
  }
}, 60000);
