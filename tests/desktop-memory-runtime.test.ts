import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { expect, it, vi } from 'vitest';
import { PiBackend } from '../src/main/pi/backend';
import { SessionIndex } from '../src/main/pi/session-index';
import { discoverPi } from '../src/main/pi/environment';
import { listMemoryFiles, readMemoryFileContent, projectMemoryFile } from '../src/main/pi/memory-bridge';
import { resolveMemoryOpen } from '../src/main/pi/memory-open';

// Real shipped runtime, temp agent/project, loopback provider. Never uses user settings or credentials.
it.skipIf(process.env.PI_TEST_RUNTIME !== 'bundled')('bundled 0.86 loads desktop-memory and automatically recaps through the configured provider into project daily', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-memory-runtime-')));
  const agent = path.join(root, 'agent'), cwd = path.join(root, 'project'), owned = path.join(agent, 'sessions/desktop');
  fs.mkdirSync(agent); fs.mkdirSync(cwd);
  const requests: any[] = [], headers: http.IncomingHttpHeaders[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body); headers.push(req.headers);
    const recap = JSON.stringify(body.messages).includes('session recap assistant');
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = (delta: any, finish: any = null) => res.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n');
    send({ role: 'assistant', content: recap ? '### Decisions\n- Runtime recap written only to this project.' : 'Fixture turn complete.' });
    send({}, 'stop'); res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port;
  fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ packages: [], compaction: { enabled: false } }));
  fs.writeFileSync(path.join(agent, 'models.json'), JSON.stringify({ providers: { fixture: {
    api: 'openai-completions', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'offline-only', headers: { 'X-Memory-Fixture': 'configured-header' },
    models: [{ id: 'fixture', input: ['text'], contextWindow: 32000, maxTokens: 1024 }],
  } } }));
  const globalFile = path.join(agent, 'memory/daily/existing.md'), legacyFile = projectMemoryFile(agent, cwd);
  for (const file of [globalFile, legacyFile]) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'unchanged'); }
  const index = new SessionIndex([owned], owned);
  const env = discoverPi({ runtime: 'bundled', agentDir: agent }, { PATH: '' }, process.env.PI_TEST_RUNTIME_DIR);
  expect(env.runtime).toBe('bundled'); expect(env.version).toBe('0.86.0');
  const backend = new PiBackend(env, index, owned, path.resolve('extensions/desktop-policy/index.mjs'), () => {});
  backend.memoryOptions = () => ({ enabled: true, dir: path.join(agent, 'memory') });
  try {
    const run = await backend.connect({ cwd, trustProject: false, permission: 'ask', model: 'fixture/fixture' });
    for (const prompt of ['Remember the project-only decision.', 'Confirm the decision.']) {
      await backend.prompt(run.key, prompt, 'followUp');
      await vi.waitFor(() => expect(backend.runs()[0].status).toBe('idle'), { timeout: 10000 });
    }
    await vi.waitFor(() => expect(listMemoryFiles(agent, cwd).filter(f => f.rel.startsWith('projects-external/daily/'))).toHaveLength(1), { timeout: 30000, interval: 100 });
    const file = listMemoryFiles(agent, cwd).find(f => f.rel.startsWith('projects-external/daily/'))!;
    expect(readMemoryFileContent(agent, file.rel, cwd)).toContain('Runtime recap written only to this project.');
    expect(resolveMemoryOpen(agent, file.rel, cwd, [cwd])).toBe(file.path);
    expect(requests).toHaveLength(3);
    expect(JSON.stringify(requests[2].messages)).toContain('User: Remember the project-only decision.');
    expect(headers[2]['x-memory-fixture']).toBe('configured-header');
    expect(headers[2].authorization).toBe('Bearer offline-only');
    expect(fs.readFileSync(globalFile, 'utf8')).toBe('unchanged');
    expect(fs.readFileSync(legacyFile, 'utf8')).toBe('unchanged');
    expect(listMemoryFiles(agent).map(f => f.path)).toEqual([globalFile]);
    console.log('Verified real automatic recap', { runtime: env.version, executable: env.executable, cli: env.launchArgs?.[0], rel: file.rel, requests: requests.length });
  } finally {
    backend.dispose(); index.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 55000);
