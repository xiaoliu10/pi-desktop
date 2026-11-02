import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startPeer, discoverPeers, sessionKey } from '../node_modules/@wengine-ai/pi-session-handoff/transport.mjs';

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

  it('dedupes at the receiver across sender restart and rejects changed retry content', async () => {
    const a = fixture(), b = fixture(); let deliveries = 0;
    const receiver = await startPeer({metadata: {sessionKey: sessionKey(b.file), cwd: b.root}, receive: async () => {deliveries++; return {disposition: 'started'};}});
    const args = {sessionKey: receiver.key, message: 'only once', source: {sessionKey: sessionKey(a.file)}, idempotencyKey: 'stable'};
    let sender = await startPeer({metadata: {sessionKey: sessionKey(a.file), cwd: a.root}, receive: async () => ({disposition: 'started'})});
    try {
      await sender.send(args); await sender.close();
      sender = await startPeer({metadata: {sessionKey: sessionKey(a.file), cwd: a.root}, receive: async () => ({disposition: 'started'})});
      expect(await sender.send(args)).toMatchObject({ok: true, duplicate: true});
      expect(deliveries).toBe(1);
      await expect(sender.send({...args, message: 'different'})).rejects.toThrow(/幂等|内容/);
    } finally {await sender.close(); await receiver.close();}
  });

  it('rejects unauthenticated, browser, malformed and oversized HTTP requests before delivery', async () => {
    const b = fixture(); let deliveries = 0;
    const receiver = await startPeer({metadata: {sessionKey: sessionKey(b.file), cwd: b.root}, receive: async () => {deliveries++; return {disposition: 'started'};}});
    try {
      const descriptor = JSON.parse(fs.readFileSync(path.join(process.env.PI_CODING_AGENT_DIR!, 'handoff/descriptors', 'descriptor-' + receiver.key + '.json'), 'utf8'));
      const url = 'http://127.0.0.1:' + descriptor.port + '/send';
      const post = (body, headers = {}) => fetch(url, {method: 'POST', headers: {authorization: 'Bearer ' + descriptor.token, ...headers}, body});
      expect((await post('{}', {authorization: 'Bearer wrong'})).status).toBe(401);
      expect((await post('{}', {origin: 'https://example.test'})).status).toBe(403);
      expect((await post('null')).status).toBe(400);
      expect((await post(JSON.stringify({message: 'x'.repeat(20001)}))).status).toBe(400);
      expect((await post('x'.repeat(65537))).status).toBe(413);
      expect(deliveries).toBe(0);
    } finally {await receiver.close();}
  });

  it('aborted discovery does not erase a live descriptor', async () => {
    const b = fixture();
    const receiver = await startPeer({metadata: {sessionKey: sessionKey(b.file), cwd: b.root}, receive: async () => ({disposition: 'started'})});
    try {
      const controller = new AbortController(); controller.abort();
      await expect(receiver.list({signal: controller.signal})).rejects.toThrow();
      expect((await receiver.list()).map(s => s.key)).toContain(receiver.key);
    } finally {await receiver.close();}
  });

  it('does not remove another instance descriptor when an older owner closes', async () => {
    const b = fixture(); const metadata = {sessionKey: sessionKey(b.file), cwd: b.root};
    const old = await startPeer({metadata, receive: async () => ({disposition: 'started'})});
    const next = await startPeer({metadata, receive: async () => ({disposition: 'started'})});
    try {
      await old.close();
      expect((await next.list()).map(s => s.key)).toContain(next.key);
    } finally {await old.close(); await next.close();}
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

  it('update after close cannot bring a dead peer back into the candidate list', async () => {
    const a = fixture(), b = fixture();
    const receiver = await startPeer({registryDir: b.registry, metadata: {sessionKey: sessionKey(b.file), cwd: b.root}, receive: async () => ({disposition: 'started'})});
    const sender = await startPeer({registryDir: a.registry, metadata: {sessionKey: sessionKey(a.file), cwd: a.root}, receive: async () => ({disposition: 'started'})});
    await receiver.close();
    // A late agent_settled can still call update(); it must not rewrite the descriptor,
    // otherwise this dead session reappears as a selectable handoff target.
    await receiver.update({name: 'zombie'});
    // discoverPeers does not exclude self, so assert the CLOSED peer is absent rather
    // than that the list is empty (the sender itself is legitimately present).
    const live = await sender.list();
    expect(live.map(s => s.sessionKey)).not.toContain(receiver.key);
    await expect(sender.send({sessionKey: receiver.key, message: 'still dead'})).rejects.toThrow(/已退出|不在线/);
    await sender.close();
  });
});
