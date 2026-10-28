import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startPeer, discoverPeers, sessionKey } from '../extensions/session-handoff/transport.mjs';

// The registry is machine-wide by design: peers only find each other when they
// share one location. Point PI_CODING_AGENT_DIR at a temp dir per test so these
// cases never touch the real ~/.pi/agent/handoff.
const ORIGINAL_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;
beforeEach(() => { process.env.PI_CODING_AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-agent-')); });
afterEach(() => {
  if (ORIGINAL_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = ORIGINAL_AGENT_DIR;
});

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-transport-')));
  const file = path.join(root, 'session.jsonl'); fs.writeFileSync(file, '{}\n');
  return {root, file};
}

describe('local handoff transport', () => {
  it('delivers over a private loopback endpoint and returns the real disposition', async () => {
    const a = fixture(), b = fixture();
    const received = [];
    const receiver = await startPeer({registryDir: b.registry, metadata: {sessionKey: sessionKey(b.file), cwd: b.root, name: 'B'}, receive: async item => {received.push(item); return {disposition: 'started'};}});
    const sender = await startPeer({registryDir: a.registry, metadata: {sessionKey: sessionKey(a.file), cwd: a.root, name: 'A'}, receive: async () => ({disposition: 'started'})});
    const result = await sender.send({sessionKey: receiver.key, message: 'Hand off task', source: {cwd: a.root}});
    expect(result).toMatchObject({ok: true, disposition: 'started'});
    expect(received[0].message).toBe('Hand off task');
    await sender.close(); await receiver.close();
  });

  it('filters candidates by project and excludes self', async () => {
    const a = fixture(), b = fixture(), other = fixture();
    const peers = [a, b, other].map(f => startPeer({registryDir: f.registry, metadata: {sessionKey: sessionKey(f.file), cwd: f.root}, receive: async () => ({disposition: 'started'})}));
    await Promise.all(peers);
    const [pa, , po] = await Promise.all(peers);
    const list = await pa.list({projectPath: other.root});
    expect(list.map(s => s.cwd)).toEqual([other.root]);
    expect(list.some(s => s.cwd === a.root)).toBe(false);
    expect(list.some(s => s.cwd === b.root)).toBe(false);
    await Promise.all([pa.close(), po.close()]);
  });

  it('dedupes concurrent and sequential duplicate idempotency keys without extra delivery', async () => {
    const a = fixture(), b = fixture();
    let deliveries = 0;
    const receiver = await startPeer({registryDir: b.registry, metadata: {sessionKey: sessionKey(b.file), cwd: b.root}, receive: async () => {deliveries++; return {disposition: 'started'};}});
    const sender = await startPeer({registryDir: a.registry, metadata: {sessionKey: sessionKey(a.file), cwd: a.root}, receive: async () => ({disposition: 'started'})});
    const args = {sessionKey: receiver.key, message: 'only once', idempotencyKey: 'same'};
    const [x, y] = await Promise.all([sender.send(args), sender.send(args)]);
    expect([x.duplicate, y.duplicate].filter(Boolean).length).toBe(1);
    await sender.send(args);
    expect(deliveries).toBe(1);
    await sender.close(); await receiver.close();
  });

  it('refuses an unauthorized sender and oversized payloads', async () => {
    const a = fixture(), b = fixture();
    const receiver = await startPeer({registryDir: b.registry, metadata: {sessionKey: sessionKey(b.file), cwd: b.root}, receive: async () => ({disposition: 'started'})});
    const sender = await startPeer({registryDir: a.registry, metadata: {sessionKey: sessionKey(a.file), cwd: a.root}, receive: async () => ({disposition: 'started'})});
    await expect(sender.send({sessionKey: '0'.repeat(64), message: 'x'})).rejects.toThrow(/不在线|已退出/);
    await expect(sender.send({sessionKey: receiver.key, message: 'x'.repeat(20001)})).rejects.toThrow(/1–20000/);
    await sender.close(); await receiver.close();
  });

  it('excludes a dead peer from discovery instead of hanging a sender', async () => {
    const a = fixture(), b = fixture();
    const receiver = await startPeer({registryDir: b.registry, metadata: {sessionKey: sessionKey(b.file), cwd: b.root}, receive: async () => ({disposition: 'started'})});
    const sender = await startPeer({registryDir: a.registry, metadata: {sessionKey: sessionKey(a.file), cwd: a.root}, receive: async () => ({disposition: 'started'})});
    await receiver.close();
    await expect(sender.send({sessionKey: receiver.key, message: 'too late'})).rejects.toThrow(/已退出|不在线/);
    // The transport does not exclude self (the plugin layer does); what must hold is that
    // the CLOSED receiver is gone, so no dead target can be selected or pinged.
    const list = await sender.list();
    expect(list.map(s => s.sessionKey)).not.toContain(receiver.key);
    await sender.close();
  });

  it('keeps concurrent sender close from resurrecting or corrupting registry state', async () => {
    const a = fixture();
    const sender = await startPeer({registryDir: a.registry, metadata: {sessionKey: sessionKey(a.file), cwd: a.root}, receive: async () => ({disposition: 'started'})});
    await Promise.all([sender.close(), sender.close(), sender.update({name: 'late'})]);
    expect(await discoverPeers({registryDir: a.registry})).toEqual([]);
  });
});
