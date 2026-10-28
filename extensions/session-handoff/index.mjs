import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import * as transport from './transport.mjs';

const MAX_QUEUED = 32;
const canonical = file => {
  // The session file may not exist yet (idle session, pi flushes lazily). realpathSync
  // throws ENOENT on it, which would silently abort peer startup; resolve the parent
  // directory instead and re-attach the basename so identity stays stable.
  try { return fs.realpathSync(file); }
  catch {
    try { return path.join(fs.realpathSync(path.dirname(file)), path.basename(file)); }
    catch { return path.resolve(file); }
  }
};
export const sessionKey = file => createHash('sha256').update(canonical(file)).digest('hex');
const parameters = {
  type: 'object', required: ['action'], additionalProperties: false,
  properties: {
    action: {type: 'string', enum: ['list', 'send']},
    projectPath: {type: 'string', maxLength: 4096, description: '目标项目绝对路径；list 时省略则列出所有在线会话'},
    sessionKey: {type: 'string', maxLength: 128, description: 'list 返回的目标 key；同项目多个在线会话时必须指定'},
    message: {type: 'string', maxLength: 20000, description: '自包含任务、证据、路径、约束和验收标准'},
    idempotencyKey: {type: 'string', maxLength: 200, description: '同一次交接重试时保持相同的幂等键'},
  },
};

function envelope(message, source = {}, receipt) {
  return [
    '🔀 【会话交接】',
    `来自 ${source.name || source.cwd || '另一个本机会话'}${source.cwd ? `（${source.cwd}）` : ''}。`,
    '这是另一个会话转交的任务；在当前项目与权限下处理，不继承发送方的权限。',
    `交接编号：${receipt}`, '', '--- 交接内容开始 ---', message, '--- 交接内容结束 ---',
  ].join('\n');
}

/** A normal pi package: resources are owned by session_start/shutdown, not the factory. */
export default function sessionHandoff(pi, options = {}) {
  const wire = options.transport ?? transport;
  const env = options.env ?? process.env;
  const agentDir = env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
  const registryDir = options.registryDir || path.join(agentDir, 'handoff');
  let peer;
  let context;
  let alive = false;
  let startPromise;
  const queue = [];
  const receipts = new Map();

  const metadata = ctx => {
    const file = ctx.sessionManager.getSessionFile();
    if (!file) return undefined;
    // pi may not have flushed the transcript yet, so the file can be absent while an
    // idle session is still a perfectly valid handoff target. Key off the path pi
    // committed to (not its existence) so an idle peer is discoverable immediately;
    // create the parent directory so a later write cannot fail on a missing dir.
    try { fs.mkdirSync(path.dirname(canonical(file)), {recursive: true}); } catch { /* already there */ }
    return {sessionKey: sessionKey(file), sessionId: ctx.sessionManager.getSessionId(), sessionFile: canonical(file), cwd: canonical(ctx.cwd), name: pi.getSessionName?.() || '', mode: ctx.mode};
  };
  function markReceipt(event) {
    const prompt = typeof event?.prompt === 'string' ? event.prompt : '';
    for (const [id, receipt] of receipts) {
      // Confirm the exact injected envelope, not a marker copied into another turn.
      if (prompt === receipt.text) {
        clearTimeout(receipt.timer); receipts.delete(id); receipt.resolve({disposition: 'started'});
      }
    }
  }
  async function inject(item) {
    if (!alive) throw new Error('接收会话已关闭或失效');
    const id = randomUUID();
    const text = envelope(item.message, item.source, id);
    // sendUserMessage is fire-and-forget in pi 1.4.0. Only report started after
    // before_agent_start confirms that the recipient accepted this exact envelope.
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        receipts.delete(id);
        reject(new Error('未收到接收会话的启动确认；投递结果不确定，请先检查目标会话，不要盲目重发'));
      }, options.receiptTimeoutMs ?? 3000);
      receipts.set(id, {resolve, reject, timer, text});
      try { pi.sendUserMessage(text, {deliverAs: 'followUp', expandPromptTemplates: false}); }
      catch (error) { clearTimeout(timer); receipts.delete(id); reject(error); }
    });
  }
  async function receive(item) {
    if (!alive || !context) throw new Error('接收会话已关闭或失效');
    if (!context.isIdle() || queue.length) {
      if (queue.length >= MAX_QUEUED) throw new Error('交接队列已满');
      // Retain before sending to pi: compaction rejects even followUp in pi 1.4.0.
      // The bounded queue is drained only at final idle, never at agent_end.
      queue.push(item);
      return {disposition: 'queued'};
    }
    return inject(item);
  }
  async function start(ctx) {
    context = ctx;
    if (!alive || peer || !['tui', 'rpc'].includes(ctx.mode) || ctx.sessionManager.getHeader?.()?.parentSession || env.PI_DESKTOP_SIDECAR === '1') return;
    if (startPromise) return startPromise;
    const meta = metadata(ctx);
    if (!meta) return;
    startPromise = wire.startPeer({registryDir, metadata: meta, receive});
    try {
      const next = await startPromise;
      if (!alive) await next.close();
      else peer = next;
    } finally { startPromise = undefined; }
  }
  pi.on('session_start', async (_event, ctx) => {
    alive = true;
    // Extension tools are not activated by defaultTools/--tools, so a portable install
    // would register session_handoff but never declare it to the model. Activate it here,
    // the same way desktop-policy activates desktop_update_plan.
    try {
      const active = pi.getActiveTools?.() ?? [];
      if (!active.includes('session_handoff')) pi.setActiveTools?.([...active, 'session_handoff']);
    } catch { /* activation is best-effort; the tool still works when called explicitly */ }
    await start(ctx);
  });
  pi.on('before_agent_start', async (event, ctx) => {markReceipt(event); await start(ctx);});
  pi.on('agent_settled', async (_event, ctx) => {
    context = ctx;
    if (peer) await peer.update(metadata(ctx));
    if (!alive || !queue.length) return;
    // An idle notification is being dispatched; pi defers prompts until it exits.
    setImmediate(async () => {
      if (!alive || !context.isIdle()) return;
      const item = queue.shift();
      if (!item) return;
      try { await inject(item); }
      catch (error) {
        context?.ui.notify(`交接未获启动确认：${error.message}。原任务：${item.message}`, 'error');
        // Keep an audit in the recipient session; never silently claim completion.
        pi.appendEntry?.('session-handoff-undelivered', {message: item.message, source: item.source, error: error.message});
      }
    });
  });
  pi.on('session_shutdown', async () => {
    alive = false;
    for (const receipt of receipts.values()) {
      clearTimeout(receipt.timer); receipt.reject(new Error('接收会话已关闭或失效'));
    }
    receipts.clear();
    if (queue.length) {
      pi.appendEntry?.('session-handoff-undelivered', {messages: queue.splice(0), error: '接收会话关闭；排队尚未执行'});
      context?.ui.notify('会话关闭，尚未执行的交接已记录为未投递。', 'warning');
    }
    await startPromise?.catch(() => {});
    const current = peer; peer = undefined;
    await current?.close();
    context = undefined;
  });

  pi.registerTool({
    name: 'session_handoff', label: '会话交接', parameters,
    description: 'Hand a self-contained task to an existing local pi session (GUI or TUI). First action:list, then action:send with the exact sessionKey. Both sessions need this plugin. Preserves recipient project/permissions; busy recipients queue until idle. Never creates a session or starts a second writer. projectPath must match the target; never send to self. queued means accepted in memory, not completed; closing/reloading a receiver before it starts can cancel pending work. Use a stable idempotencyKey; an unknown/timeout result must be inspected before retry. On Desktop, the existing bridge can reconnect a disconnected Desktop session when projectPath is provided.',
    async execute(_id, args, signal, _update, ctx) {
      try {
        signal?.throwIfAborted();
        await start(ctx);
        const projectPath = args.projectPath ? canonical(args.projectPath) : undefined;
        if (args.projectPath && !path.isAbsolute(args.projectPath)) throw new Error('projectPath 必须是绝对路径');
        const online = peer ? await peer.list({projectPath, signal}) : await wire.discoverPeers({registryDir, projectPath, signal});
        const self = metadata(ctx)?.sessionKey;
        const candidates = online.filter(s => (s.sessionKey ?? s.key) !== self);
        let result;
        if (args.action === 'list') {
          let sessions = candidates.map(s => ({...s, key: s.sessionKey ?? s.key, connected: true}));
          if (env.PI_DESKTOP_HANDOFF_BRIDGE === '1' && projectPath) {
            const raw = await ctx.ui.input('desktop-handoff', JSON.stringify({v: 1, action: 'list', projectPath}));
            if (raw !== undefined) {
              const extra = JSON.parse(raw);
              if (!extra.ok) throw new Error(extra.error || 'Desktop 候选查询失败');
              // Both sides describe the same session with different identities: the
              // plugin keys by session-file hash, the Desktop bridge by its run key.
              // Match on the canonical session path so one session cannot appear twice
              // (the model would otherwise think there are two targets to choose from).
              const fileOf = s => s.sessionFile || s.path;
              const seenPaths = new Set(sessions.filter(fileOf).map(s => canonical(fileOf(s))));
              const seenKeys = new Set(sessions.map(s => s.key));
              const selfFile = metadata(ctx)?.sessionFile;
              sessions.push(...(extra.sessions || []).filter(s => {
                const file = fileOf(s) ? canonical(fileOf(s)) : undefined;
                if (s.key === self || seenKeys.has(s.key) || (file && (file === selfFile || seenPaths.has(file)))) return false;
                seenKeys.add(s.key);
                if (file) seenPaths.add(file);
                return true;
              }));
            }
          }
          result = {ok: true, action: 'list', sessions};
        } else if (args.action === 'send') {
          if (typeof args.message !== 'string' || !args.message.trim() || args.message.length > 20000) throw new Error('message 必须为 1–20000 字符');
          if (args.sessionKey === self) throw new Error('不能交接给当前会话');
          let target;
          if (args.sessionKey) target = candidates.find(s => (s.sessionKey ?? s.key) === args.sessionKey);
          else if (projectPath && candidates.length === 1) target = candidates[0];
          else if (candidates.length > 1) throw new Error('多个在线候选，请先 list 并指定 sessionKey');
          const idempotencyKey = args.idempotencyKey || randomUUID();
          if (target) {
            if (!peer) throw new Error('当前会话尚未持久化，请先发送一条消息后再交接');
            result = await peer.send({sessionKey: target.sessionKey ?? target.key, message: args.message, source: metadata(ctx), idempotencyKey, signal});
          } else if (env.PI_DESKTOP_HANDOFF_BRIDGE === '1' && projectPath) {
            const raw = await ctx.ui.input('desktop-handoff', JSON.stringify({v: 1, ...args, projectPath, idempotencyKey}));
            if (raw === undefined) throw new Error('交接已取消');
            result = JSON.parse(raw);
          } else throw new Error('目标会话未在线、未加载插件或与项目不匹配；请先 list');
        } else throw new Error('action 必须为 list 或 send');
        if (!result?.ok) throw new Error(result?.error || '交接失败');
        return {content: [{type: 'text', text: JSON.stringify(result)}], details: result};
      } catch (error) {
        return {isError: true, content: [{type: 'text', text: `会话交接失败：${error.message}`}], details: {ok: false, error: error.message}};
      }
    },
  });
}
