/** Private, on-demand local transport. No broker, polling, or automatic retries. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createHash, randomBytes, randomUUID} from 'node:crypto';

export const MESSAGE_MAX = 20000;
const MAX_RECEIPTS = 2048;
const KEY = /^[0-9a-f]{64}$/;
const canonical = file => {
  try { return fs.realpathSync(file); }
  catch {
    try { return path.join(fs.realpathSync(path.dirname(file)), path.basename(file)); }
    catch { return path.resolve(file); }
  }
};
export const sessionKey = file => createHash('sha256').update(canonical(file)).digest('hex');

function registry(root) {
  const dir = root || path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent'), 'handoff');
  const descriptors = path.join(dir, 'descriptors');
  for (const folder of [dir, descriptors]) {
    fs.mkdirSync(folder, {recursive: true, mode: 0o700});
    const stat = fs.lstatSync(folder);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('交接注册目录必须为真实目录');
    fs.chmodSync(folder, 0o700);
  }
  return descriptors;
}
const describe = key => `descriptor-${key}.json`;
async function readDescriptor(dir, key) {
  if (!KEY.test(key)) return undefined;
  let handle;
  try {
    handle = await fs.promises.open(path.join(dir, describe(key)), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 32768 || (process.platform !== 'win32' && ((stat.mode & 0o077) || stat.uid !== process.getuid()))) return undefined;
    const d = JSON.parse(await handle.readFile('utf8'));
    if (d.sessionKey === key && typeof d.token === 'string' && d.token.length >= 32 && typeof d.instanceId === 'string' && Number.isInteger(d.port) && d.port > 0 && d.port < 65536) return d;
  } catch { /* Missing or invalid descriptors are never candidates. */ }
  finally { await handle?.close(); }
}
async function writeDescriptor(dir, descriptor) {
  const temp = path.join(dir, `.${randomUUID()}.tmp`);
  try {
    await fs.promises.writeFile(temp, JSON.stringify(descriptor), {mode: 0o600, flag: 'wx'});
    await fs.promises.rename(temp, path.join(dir, describe(descriptor.sessionKey)));
  } finally { await fs.promises.rm(temp, {force: true}); }
}

async function request(d, route, body, signal) {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), route === 'ping' ? 2500 : 6000);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, {once: true});
  try {
    const res = await fetch(`http://127.0.0.1:${d.port}/${route}`, {method: 'POST', headers: {'content-type': 'application/json', authorization: `Bearer ${d.token}`}, body: JSON.stringify(body), signal: controller.signal});
    if (!res.ok) throw new Error(`接收服务返回 ${res.status}`);
    return await res.json();
  } catch (error) {
    if (signal?.aborted) throw new Error('交接已取消；如已发送，请先检查目标会话');
    throw new Error(`投递结果不确定，请先检查目标会话，不要盲目重发：${error.message}`);
  } finally {clearTimeout(timer); signal?.removeEventListener('abort', onAbort);}
}
async function probe(dir, key, signal) {
  signal?.throwIfAborted();
  const d = await readDescriptor(dir, key);
  if (!d) return undefined;
  try {
    const reply = await request(d, 'ping', {}, signal);
    if (reply.instanceId === d.instanceId) return d;
  } catch { signal?.throwIfAborted(); }
  // A transient liveness failure is not proof that the owner is dead. Leave cleanup
  // to that owner; deleting here races replacement and cancelled discovery.
  return undefined;
}
export async function discoverPeers({registryDir, projectPath, signal} = {}) {
  const dir = registry(registryDir);
  const names = await fs.promises.readdir(dir);
  const target = projectPath ? canonical(projectPath) : undefined;
  const result = await Promise.all(names.filter(n => /^descriptor-[0-9a-f]{64}\.json$/.test(n)).map(async n => {
    const d = await probe(dir, n.slice(11, -5), signal);
    if (!d || (target && d.cwd !== target)) return undefined;
    const {token, port, instanceId, ...metadata} = d;
    return {...metadata, key: d.sessionKey};
  }));
  return result.filter(Boolean);
}

export async function startPeer({registryDir, metadata, receive}) {
  if (!KEY.test(metadata.sessionKey)) throw new Error('无效 sessionKey');
  const dir = registry(registryDir);
  const peer = {metadata, token: randomBytes(32).toString('base64url'), instanceId: randomUUID(), closed: false};
  const receipts = new Map();
  async function accept(payload) {
    if (peer.closed) throw new Error('接收会话已关闭或失效');
    const key = JSON.stringify([payload.source?.sessionKey || '', payload.idempotencyKey]);
    const fingerprint = createHash('sha256').update(JSON.stringify([payload.message, payload.source || {}])).digest('hex');
    const prior = receipts.get(key);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new Error('幂等键已用于不同内容');
      return {...await prior.promise, duplicate: true};
    }
    // Never evict uncertain results: a retry must not become a second delivery.
    if (receipts.size >= MAX_RECEIPTS) throw new Error('交接幂等记录已满，请开启新会话');
    const promise = Promise.resolve().then(() => receive(payload));
    receipts.set(key, {fingerprint, promise});
    return promise;
  }
  const listener = http.createServer((req, res) => {
    const reply = (status, data) => {if (!res.writableEnded) res.writeHead(status, {'content-type': 'application/json'}).end(JSON.stringify(data));};
    if (req.method !== 'POST' || !['/ping', '/send'].includes(req.url)) {reply(404, {ok: false}); req.resume(); return;}
    if (req.headers.origin) {reply(403, {ok: false}); req.resume(); return;}
    if (req.headers.authorization !== `Bearer ${peer.token}`) {reply(401, {ok: false}); req.resume(); return;}
    let size = 0; const chunks = [];
    req.on('error', () => {});
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 65536) {chunks.length = 0; reply(413, {ok: false}); return;}
      chunks.push(chunk);
    });
    req.on('end', async () => {
      if (res.writableEnded) return;
      if (req.url === '/ping') {reply(200, {ok: !peer.closed, instanceId: peer.closed ? null : peer.instanceId}); return;}
      let payload;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!payload || typeof payload.message !== 'string' || !payload.message.trim() || payload.message.length > MESSAGE_MAX || typeof payload.idempotencyKey !== 'string' || !payload.idempotencyKey || payload.idempotencyKey.length > 200 || (payload.source !== undefined && (!payload.source || typeof payload.source !== 'object' || Array.isArray(payload.source)))) throw new Error('invalid payload');
      } catch {reply(400, {ok: false, error: '无效交接内容'}); return;}
      try {reply(200, {ok: true, ...await accept(payload)});}
      catch (error) {reply(200, {ok: false, error: error.message});}
    });
  });
  listener.requestTimeout = 10000;
  listener.headersTimeout = 10000;
  await new Promise((resolve, reject) => {listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve);});
  const descriptor = () => ({...peer.metadata, token: peer.token, instanceId: peer.instanceId, port: listener.address()?.port});
  try {await writeDescriptor(dir, descriptor());}
  catch (error) {listener.close(); throw error;}
  let writes = Promise.resolve(); let closing;
  const key = metadata.sessionKey;
  return {
    key, token: peer.token,
    metadata: () => peer.metadata,
    list: args => discoverPeers({registryDir, ...args}),
    async send({sessionKey: targetKey, message, source, idempotencyKey = randomUUID(), signal}) {
      if (peer.closed) throw new Error('发送会话已关闭');
      if (!KEY.test(targetKey)) throw new Error('目标会话不在线或无效');
      if (typeof message !== 'string' || !message.trim() || message.length > MESSAGE_MAX) throw new Error(`message 必须为 1–${MESSAGE_MAX} 字符`);
      if (typeof idempotencyKey !== 'string' || !idempotencyKey || idempotencyKey.length > 200) throw new Error('无效幂等键');
      const d = await probe(dir, targetKey, signal);
      if (!d) throw new Error('目标会话不在线或已退出，请重新 list');
      const result = await request(d, 'send', {message, source: source || {sessionKey: key}, idempotencyKey}, signal);
      if (!result.ok) throw new Error(result.error || '接收方拒绝投递');
      return result;
    },
    update(next) {
      writes = writes.catch(() => {}).then(async () => {
        if (peer.closed) return peer.metadata;
        peer.metadata = {...peer.metadata, ...next, sessionKey: key};
        await writeDescriptor(dir, descriptor());
        return peer.metadata;
      });
      return writes;
    },
    close() {
      if (closing) return closing;
      peer.closed = true;
      closing = (async () => {
        await writes.catch(() => {});
        const current = await readDescriptor(dir, key);
        if (current?.instanceId === peer.instanceId) await fs.promises.rm(path.join(dir, describe(key)), {force: true});
        await new Promise(resolve => listener.close(resolve));
      })();
      return closing;
    },
  };
}
