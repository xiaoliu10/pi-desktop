import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { PiBackend } from '../src/main/pi/backend';
import { SessionIndex } from '../src/main/pi/session-index';
import { discoverPi } from '../src/main/pi/environment';
import type { PiEvent } from '../src/shared/pi';

// Opt-in, real bundled RPC + loopback fixture only. No model service or user config.
it.skipIf(process.env.PI_TEST_RUNTIME !== 'bundled').each([false, true])('real bundled retry recovery (suppress native settlement=%s), prompt acceptance and queue budget', async suppressNativeSettlement => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-retry-runtime-')));
  const agent = path.join(root, 'agent'), owned = path.join(agent, 'sessions/desktop');
  fs.mkdirSync(agent);
  const events: PiEvent[] = [], requests: any[] = [];
  let healthy = false;
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    if (requests.length > 1 && !healthy) {
      res.writeHead(503, { 'Content-Type': 'application/json', 'retry-after': '0' });
      res.end(JSON.stringify({ error: { message: '503 Service temporarily unavailable', type: 'server_error' } })); return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = (delta: any, finish: any = null) => res.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n');
    if (requests.length === 1) {
      await firstGate;
      send({ role: 'assistant', tool_calls: [{ index: 0, id: 'successful-write', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'result.txt', content: 'written once' }) } }] });
      send({}, 'tool_calls');
    } else { send({ role: 'assistant', content: 'Fixture recovery complete.' }); send({}, 'stop'); }
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port;
  fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ packages: [], retry: { enabled: true, maxRetries: 3, baseDelayMs: 1, maxDelayMs: 1 }, compaction: { enabled: false } }));
  fs.writeFileSync(path.join(agent, 'models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'offline-only', models: [{ id: 'fixture', input: ['text'], contextWindow: 32000, maxTokens: 1024 }] } } }));
  const index = new SessionIndex([owned], owned);
  const env = discoverPi({ runtime: 'bundled', agentDir: agent }, { PATH: '' }, process.env.PI_TEST_RUNTIME_DIR);
  expect(env.runtime).toBe('bundled'); expect(env.version).toBe('0.86.0');
  const cli = env.launchArgs![0];
  const chunkDir = path.join(path.dirname(cli), 'chunks');
  const chunks = fs.readdirSync(chunkDir).filter(f => f.endsWith('.js')).sort().map(f => fs.readFileSync(path.join(chunkDir, f))).join('');
  console.log('Exact tested runtime', { executable: env.executable, cli, version: env.version, chunksSha256: createHash('sha256').update(chunks).digest('hex') });
  const backend = new PiBackend(env, index, owned, path.resolve('extensions/desktop-policy/index.mjs'), event => events.push(structuredClone(event)));
  if (suppressNativeSettlement) {
    const onEvent = (backend as any).onEvent.bind(backend);
    (backend as any).onEvent = (run: any, event: any) => {
      if (event.type !== 'agent_settled' || event.source === 'desktop-wait-for-idle') onEvent(run, event);
    };
  }
  try {
    const run = await backend.connect({ cwd: root, trustProject: false, permission: 'fullAccess', model: 'fixture/fixture' });
    const rawEvents: any[] = [];
    (backend as any).active.get(run.key).client.on('event', (event: any) => rawEvents.push(event));
    let accepted = false;
    const prompt = backend.prompt(run.key, 'Write result.txt then report completion.', 'followUp').then(() => { accepted = true; });
    // Actual RPC must ACK preflight while provider is still blocked, not after
    // the task's tool/model/retry rounds. Older delayed ACKs are separately simulated.
    await vi.waitFor(() => expect(accepted).toBe(true), { timeout: 5000 });
    releaseFirst(); await prompt;
    await vi.waitFor(() => expect(backend.runs()[0].retryGroup?.phase).toBe('waiting'), { timeout: 40000, interval: 50 });
    expect(backend.runs()[0].retryGroup).toMatchObject({ group: 1, maxGroups: 10, delayMs: 10000 });
    expect(events.filter(e => e.type === 'rpc' && e.event.type === 'auto_retry_start').map((e: any) => e.event.attempt)).toEqual([1, 2, 3]);
    expect(events.filter(e => e.type === 'rpc' && e.event.type === 'agent_settled')).toHaveLength(0);
    // Backend suppresses intermediate settlement for UI; that never meant the
    // runtime lacked the raw protocol event. Capture the wire independently.
    expect(rawEvents.filter(e => e.type === 'agent_settled').length).toBeGreaterThan(0);
    healthy = true;
    await backend.prompt(run.key, 'Queued after recovery.', 'followUp');
    await vi.waitFor(() => expect(backend.runs()[0].status).toBe('idle'), { timeout: 20000, interval: 50 });
    await vi.waitFor(() => expect(backend.runs()[0].pending).toBe(0), { timeout: 10000 });
    await vi.waitFor(() => expect(index.history(run.key).entries.filter(e => e.message?.role === 'user')).toHaveLength(2));
    const history = index.history(run.key).entries;
    expect(history.filter(e => e.message?.role === 'toolResult')).toHaveLength(1);
    expect(history.filter(e => e.type === 'custom_message' && e.customType === 'desktop-retry-continuation')).toHaveLength(1);
    expect(events.filter(e => e.type === 'rpc' && e.event.type === 'tool_execution_start')).toHaveLength(1);
    expect(events.some(e => e.type === 'run' && e.run.retryGroup?.group === 2 && e.run.retryGroup.phase === 'completed')).toBe(true);
    const recovery = requests.find(body => JSON.stringify(body.messages).includes('The upstream request failed after its internal retries.'));
    expect(recovery).toBeDefined();
    expect(recovery.messages.filter((m: any) => m.role === 'tool' && m.tool_call_id === 'successful-write')).toHaveLength(1);
    expect(recovery.messages.filter((m: any) => JSON.stringify(m.content).includes('Write result.txt then report completion.'))).toHaveLength(1);
    expect(fs.readFileSync(path.join(root, 'result.txt'), 'utf8')).toBe('written once');
    expect(backend.runs()[0].retryGroup).toMatchObject({ group: 1, phase: 'completed' });
    expect(JSON.parse(fs.readFileSync(path.join(agent, 'settings.json'), 'utf8')).retry.maxRetries).toBe(3);
  } finally {
    releaseFirst(); backend.dispose(); index.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 70000);
