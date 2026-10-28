/**
 * On-demand local handoff transport: no broker process, no polling. Each session
 * publishes a private loopback endpoint when it starts; senders discover and
 * connect only for a specific handoff, then close.
 *
 * Descriptor files are the durability layer. They carry only identity and
 * metadata (no secrets), and are scoped 0600 in a 0700 directory because any
 * local process that can write them could otherwise hijack a handoff target.
 * A descriptor that fails to reach its endpoint (stale/dead) is excluded from
 * discovery and removed, so a crashed session never blocks its peers.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

export const MESSAGE_MAX = 20000;
const READ_TIMEOUT_MS = 2500;
const CONNECT_TIMEOUT_MS = 1200;
const IDLE_GRACE_MS = 5000;
const IDEMPOTENCY_MAX = 8;

const canonical = file => {
  // Same contract as the plugin: the session file may not exist yet.
  try { return fs.realpathSync(file); }
  catch {
    try { return path.join(fs.realpathSync(path.dirname(file)), path.basename(file)); }
    catch { return path.resolve(file); }
  }
};
export const sessionKey = file => createHash('sha256').update(canonical(file)).digest('hex');

/**
 * The registry must be ONE shared machine-wide location. Deriving it from each
 * caller's registryDir (as an earlier revision did) makes peers invisible to each
 * other: a sender looks in its own temp dir and finds nobody. Derive it from
 * PI_CODING_AGENT_DIR when set, otherwise ~/.pi/agent/handoff, so every session
 * on the machine resolves the same descriptors directory.
 */
function agentRoot() {
  const dir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
  try { return fs.realpathSync(dir); } catch { return path.resolve(dir); }
}

function registry() {
  const dir = path.join(agentRoot(), 'handoff');
  const descriptors = path.join(dir, 'descriptors');
  try { fs.mkdirSync(descriptors, {recursive: true, mode: 0o700}); } catch { /* already exists */ }
  try { fs.chmodSync(dir, 0o700); fs.chmodSync(descriptors, 0o700); } catch { /* ignore */ }
  return descriptors;
}

const describe = key => `descriptor-${key}.json`;
const readDescriptor = async (descriptors, key) => {
  try {
    const raw = await fs.promises.readFile(path.join(descriptors, describe(key)), 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed?.token === 'string' && typeof parsed?.port === 'number') return parsed;
  } catch { /* stale, missing, or malformed descriptor */ }
  return undefined;
};
const writeDescriptor = async (descriptors, metadata, token, port, instanceId) => {
  const file = path.join(descriptors, describe(metadata.sessionKey));
  await fs.promises.writeFile(file, JSON.stringify({...metadata, token, port, instanceId}), {mode: 0o600});
};

/** A descriptor is only alive when the endpoint answers with THIS instance id.
 *  Without it, a closed peer's port can be reused by any later listener and a
 *  dead session keeps showing up as an available handoff target. */
async function ping(descriptor, signal) {
  const result = await request(`http://127.0.0.1:${descriptor.port}/ping`, {}, descriptor.token, signal);
  return result?.instanceId === descriptor.instanceId;
}

/** Bound to 127.0.0.1 with a token: only local peers that know this endpoint's
 *  descriptor can talk to it. Browser Origin requests are refused outright.
 *  /ping is liveness-only and never reaches the session: probing must not
 *  consume a queued handoff or trigger a turn. */
function server(peer, receive) {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method !== 'POST' || (url.pathname !== '/send' && url.pathname !== '/ping')) { res.writeHead(404).end(); return; }
    if (req.headers.origin) { res.writeHead(403, {'content-type': 'application/json'}).end('{"ok":false,"error":"browser requests are not accepted"}'); return; }
    if (req.headers.authorization !== `Bearer ${peer.token}`) { res.writeHead(401, {'content-type': 'application/json'}).end('{"ok":false,"error":"unauthorized"}'); return; }
    let size = 0; const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 64 * 1024) { req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', async () => {
      if (url.pathname === '/ping') {
        // Answer with the endpoint's own instance id so a caller can tell this
        // listener apart from a different one that later reused the port.
        res.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify({ok: true, instanceId: peer.instanceId}));
        return;
      }
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const result = await peer.receive(payload);
        // A receiver reports the disposition it actually reached. Normalize it here so a
        // successful injection is never read as a rejection, and never as "executed".
        res.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify({ok: true, ...result}));
      } catch (error) {
        res.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify({ok: false, error: error.message ?? String(error)}));
      }
    });
  });
}

/** Fetches with abort and idle guard; retries never happen automatically. */
async function request(url, body, token, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), READ_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, {once: true});
  try {
    const res = await fetch(url, {method: 'POST', headers: {'content-type': 'application/json', authorization: `Bearer ${token}`}, body: JSON.stringify(body), signal: controller.signal});
    if (!res.ok) throw new Error(`接收服务返回 ${res.status}`);
    const text = await res.text();
    try { return JSON.parse(text); }
    catch { throw new Error('接收服务返回了无效响应'); }
  } catch (error) {
    if (signal?.aborted) throw new Error('交接已取消');
    if (error.name === 'AbortError') throw new Error('接收会话无响应或已退出；投递结果不确定，请检查目标会话');
    throw error;
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
  }
}

async function withTimeout(promise, ms, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {timer = setTimeout(() => reject(new Error(message)), ms);})]); }
  finally { clearTimeout(timer); }
}

/** Probe a peer endpoint: an unreachable descriptor is stale, not a peer.
 *  Uses /ping so liveness checks never consume a queued handoff. */
async function probe(descriptors, key, signal) {
  const descriptor = await readDescriptor(descriptors, key);
  if (!descriptor) return {status: 'missing'};
  try {
    const alive = await ping(descriptor, signal);
    if (!alive) throw new Error('endpoint belongs to another instance');
    return {status: 'live', descriptor};
  } catch {
    // The descriptor is dead (or its port was reused); remove it so later lists skip it.
    await fs.promises.rm(path.join(descriptors, describe(key)), {force: true}).catch(() => {});
    return {status: 'stale'};
  }
}

export async function discoverPeers({registryDir, projectPath, signal}) {
  const descriptors = registry(registryDir);
  let names = [];
  try { names = await fs.promises.readdir(descriptors); } catch { return []; }
  const keys = names.filter(n => /^descriptor-[0-9a-f]{64}\.json$/.test(n)).map(n => n.slice(11, -5));
  const target = projectPath ? canonical(projectPath) : undefined;
  const results = [];
  for (const key of keys) {
    const probed = await probe(descriptors, key, signal);
    if (probed.status !== 'live') continue;
    const {token, port, instanceId, ...metadata} = probed.descriptor;
    if (target && metadata.cwd !== target) continue;
    results.push({...metadata, key, sessionKey: key});
  }
  return results;
}

export async function startPeer({registryDir, metadata, receive}) {
  const descriptors = registry(registryDir);
  const token = randomBytes(32).toString('base64url');
  // The instance id must exist before the listener is created: /ping answers with it,
  // and a missing value makes every live peer look stale to every sender.
  const instanceId = randomUUID();
  const listener = server({instanceId, token, receive}, receive);
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  }).catch(error => { throw new Error(`交接服务监听失败：${error.message}`); });
  const port = listener.address().port;
  const peer = {
    instanceId,
    token,
    key: metadata.sessionKey,
    metadata,
    listener,
    inFlight: new Map(),
    recent: new Map(),
    lastSeen: Date.now(),
    receive: async payload => {
      // Delivery receipts for peers that recently vanished: the receiver is gone,
      // so the message cannot be delivered. Do not claim success.
      if (Date.now() - peer.lastSeen < IDLE_GRACE_MS && peer.closed) throw new Error('接收会话已关闭或失效');
      return receive(payload);
    },
  };
  await writeDescriptor(descriptors, metadata, token, port, peer.instanceId);

  async function send({sessionKey: targetKey, message, source, idempotencyKey, signal}) {
    if (!targetKey || typeof targetKey !== 'string') throw new Error('缺少目标 sessionKey');
    if (typeof message !== 'string' || !message.trim() || message.length > MESSAGE_MAX) throw new Error(`message 必须为 1–${MESSAGE_MAX} 字符的自包含内容`);
    const key = idempotencyKey ? String(idempotencyKey).slice(0, 200) : undefined;
    if (key) {
      const prior = peer.recent.get(key);
      // A repeat reports the cached outcome and marks itself a duplicate, so the model
      // never mistakes a retry for a second delivery.
      if (prior) return {...prior, duplicate: true};
      const pending = peer.inFlight.get(key);
      if (pending) return pending.then(result => ({...result, duplicate: true}));
    }
    const delivery = (async () => {
      const probed = await probe(descriptors, targetKey, signal);
      if (probed.status === 'stale') throw new Error('目标会话已退出或未持久化，无法投递；请重新 list');
      if (probed.status === 'missing') throw new Error('目标会话不在线、未加载交接插件或不在本机注册表；请重新 list');
      const result = await request(`http://127.0.0.1:${probed.descriptor.port}/send`, {id: randomUUID(), message, source, idempotencyKey: key}, probed.descriptor.token, signal);
      if (!result?.ok) throw new Error(result?.error || '接收方拒绝投递');
      if (key) peer.recent.set(key, result);
      return result;
    })();
    if (key) {
      peer.inFlight.set(key, delivery);
      delivery.catch(() => {});
      const settled = await delivery;
      peer.inFlight.delete(key);
      return settled;
    }
    return delivery;
  }

  function list({projectPath, signal} = {}) {
    return discoverPeers({registryDir, projectPath, signal});
  }

  async function update(next) {
    const merged = {...peer.metadata, ...next};
    peer.metadata = merged;
    await writeDescriptor(descriptors, merged, token, port, peer.instanceId);
    return merged;
  }

  async function close() {
    if (peer.closed) return;
    peer.closed = true;
    await new Promise(resolve => listener.close(() => resolve()));
    await new Promise(resolve => setImmediate(resolve));
    await fs.promises.rm(path.join(descriptors, describe(peer.key)), {force: true}).catch(() => {});
  }

  return {key: peer.key, token, list, send, update, close, metadata: () => peer.metadata};
}
