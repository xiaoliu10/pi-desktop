import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

// A real pi process with the plugin loaded must (a) start, (b) register
// session_handoff in the ACTIVE tool set, and (c) publish a descriptor other
// peers can discover. This is the proof the earlier <tools>-block check could
// not give: extension tools are active but never listed in that block.
const root = process.cwd();
const cli = path.join(root, 'resources/pi-runtime/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js');
const plugin = path.join(root, 'extensions/session-handoff/index.mjs');

function fixture() {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-real-')));
  const agent = path.join(tmp, 'agent'); fs.mkdirSync(agent);
  fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({retry: {enabled: false}, packages: []}));
  return {tmp, agent};
}

describe('session_handoff in a real pi process', () => {
  it('registers in the active tool set and publishes a discoverable descriptor', async () => {
    const {tmp, agent} = fixture();
    const server = http.createServer((req, res) => {
      let b = ''; req.on('data', d => b += d);
      req.on('end', () => { res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify({choices: [{message: {role: 'assistant', content: 'ok'}, finish_reason: 'stop'}], usage: {prompt_tokens: 1, completion_tokens: 1}})); });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as any).port;
    fs.writeFileSync(path.join(agent, 'models.json'), JSON.stringify({providers: {o: {baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', apiKey: 'x', models: [{id: 'm', name: 'm', input: ['text'], contextWindow: 4096, maxTokens: 64}]}}}));

    const cwd = path.join(tmp, 'proj'); fs.mkdirSync(cwd);
    const file = path.join(cwd, 's.jsonl');
    const child = spawn(process.execPath, [cli, '--mode', 'rpc', '--session', file, '--session-dir', cwd, '-e', plugin, '--model', 'm', '--no-approve'], {cwd, env: {...process.env, PI_CODING_AGENT_DIR: agent, PI_PACKAGE_DIR: undefined, PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT: undefined}, stdio: ['pipe', 'pipe', 'pipe']});
    let err = '';
    child.stderr.on('data', d => { err += d; });
    await new Promise(r => setTimeout(r, 3000));
    // Read the registry BEFORE terminating: SIGTERM lets session_shutdown run and
    // remove the descriptor (correct cleanup), so checking after kill would race.
    const descriptors = path.join(fs.realpathSync(agent), 'handoff', 'descriptors');
    const names = fs.existsSync(descriptors) ? fs.readdirSync(descriptors) : [];
    child.kill();
    server.close();

    // The plugin writes its own audit line to stderr from session_start.
    const activeMatch = /DBG active before= (\[[^\]]*\])/.exec(err);
    expect(activeMatch, `plugin did not report active tools; stderr: ${err.slice(0, 400)}`).not.toBeNull();
    expect(JSON.parse(activeMatch![1])).toContain('session_handoff');
    // And a descriptor exists for this session, so peers can discover it.
    expect(names.length, `no descriptor published; stderr: ${err.slice(0, 400)}`).toBeGreaterThan(0);
  }, 30000);
});
