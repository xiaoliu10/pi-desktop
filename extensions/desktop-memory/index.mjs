/**
 * Desktop 自动摘要。PI_DESKTOP_MEMORY=1 开启；DIR 仅用于无项目会话的全局记忆。
 * 有 CWD 时只追加 <cwd>/.pi/memory/daily/YYYY-MM-DD.md；路径失败绝不回退全局。
 * 旧全局/截断 slug 文件不迁移、不续写。第三方 memory 工具的召回范围由插件管理。
 * agent_end 后静默 20 秒、至少 4 条消息、单飞行 + 2 分钟冷却；尽力而为，不进对话流。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MIN_MESSAGES = 4;
const DEBOUNCE_MS = 20_000;
const COOLDOWN_MS = 120_000;
const TIMEOUT_MS = 60_000;
const MAX_CONVERSATION_CHARS = 80_000;

const SYSTEM_PROMPT = [
  'You are a session recap assistant.',
  'Read the conversation and extract key decisions, lessons learned, notes, and follow-ups.',
  'Return ONLY markdown in the specified format, without any extra commentary.',
].join('\n');

function buildPrompt(conversationText, truncated, totalChars) {
  const lines = [
    'Review the conversation and extract important decisions, lessons learned, notes, and follow-ups for a daily log.',
    'Return markdown only with these exact headings:',
    '### Decisions', '### Lessons Learned', '### Notes', '### Follow-ups',
    'Use bullet points under each heading. If there is nothing, write "None.".',
  ];
  if (truncated) lines.push(`Note: Conversation transcript was truncated to the most recent ${conversationText.length} of ${totalChars} characters.`);
  lines.push('', '<conversation>', conversationText, '</conversation>');
  return lines.join('\n');
}

function serializeConversation(messages) {
  const parts = [];
  for (const message of messages) {
    if (!['user', 'assistant', 'toolResult'].includes(message.role)) continue;
    const role = message.role === 'assistant' ? 'Assistant' : message.role === 'toolResult' ? 'Tool' : 'User';
    const content = message.content;
    const text = (typeof content === 'string' ? content : Array.isArray(content)
      ? content.filter(c => c?.type === 'text' && typeof c.text === 'string').map(c => c.text).join('\n') : '').trim();
    if (text) parts.push(`${role}: ${text}`);
  }
  return parts.join('\n\n');
}

/** Create one directory at a time, never follow links below the trusted anchor. */
function ensureDirectories(anchor, parts) {
  let cursor = fs.realpathSync(anchor);
  if (!fs.statSync(cursor).isDirectory()) throw new Error('记忆根目录无效');
  for (const part of parts) {
    cursor = path.join(cursor, part);
    try { fs.mkdirSync(cursor, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const st = fs.lstatSync(cursor);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('记忆路径不允许符号链接或非目录');
  }
  return cursor;
}

export function appendMemorySummary(dir, cwd, text, now = new Date()) {
  const project = cwd !== undefined && cwd !== '';
  if (project && (typeof cwd !== 'string' || !path.isAbsolute(cwd) || cwd.includes('\0'))) throw new Error('项目路径无效');
  // No mkdir(project) and no global fallback: a moved/missing project must fail closed.
  const daily = project
    ? ensureDirectories(cwd, ['.pi', 'memory', 'daily'])
    : ensureDirectories(path.dirname(path.resolve(dir)), [path.basename(path.resolve(dir)), 'daily']);
  const file = path.join(daily, `${now.toISOString().slice(0, 10)}.md`);
  const stamp = now.toISOString().replace('T', ' ').slice(0, 19);
  const entry = [`<!-- ${stamp} [desktop-auto] -->`, '## Turn Summary (auto, desktop)', '', text.trim(), ''].join('\n');
  // O_NOFOLLOW protects the final file too (including a dangling link).
  try {
    const st = fs.lstatSync(file);
    if (st.isSymbolicLink() || !st.isFile()) throw new Error('记忆文件无效');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('记忆文件无效');
    fs.writeFileSync(fd, entry, 'utf8');
  } finally { fs.closeSync(fd); }
  return file;
}

export default function desktopMemory(pi) {
  if (process.env.PI_DESKTOP_MEMORY !== '1') return;
  const dir = process.env.PI_DESKTOP_MEMORY_DIR || path.join(os.homedir(), '.pi', 'agent', 'memory');
  const cwd = process.env.PI_DESKTOP_MEMORY_CWD;
  let timer = null;
  let lastRunAt = -Infinity;
  let inFlight = false;
  let stopped = false;
  let controller;

  const consolidate = async (ctx) => {
    if (stopped || inFlight || Date.now() - lastRunAt < COOLDOWN_MS) return;
    if (!ctx.isIdle?.() || ctx.hasPendingMessages?.()) return;
    const branch = ctx.sessionManager?.getBranch?.();
    const messages = Array.isArray(branch)
      ? branch.filter(e => e?.type === 'message' && ['user', 'assistant', 'toolResult'].includes(e.message?.role)).map(e => e.message)
      : [];
    if (messages.length < MIN_MESSAGES || !ctx.model) return;
    const conversationText = serializeConversation(messages);
    if (!conversationText.trim()) return;
    const truncated = conversationText.length > MAX_CONVERSATION_CHARS;
    const text = truncated ? conversationText.slice(-MAX_CONVERSATION_CHARS) : conversationText;
    inFlight = true;
    lastRunAt = Date.now();
    controller = new AbortController();
    const signal = controller.signal;
    let timeout;
    try {
      // Supported pi 0.86 extension API: uses the configured provider + auth/headers.
      // No argv-based dist/compat import and no removed ModelRegistry.getApiKey gate.
      const response = await Promise.race([
        ctx.modelRegistry.streamSimple(ctx.model, {
          systemPrompt: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: [{ type: 'text', text: buildPrompt(text, truncated, conversationText.length) }], timestamp: Date.now() }],
        }, { reasoning: 'low', signal }).result(),
        new Promise((_, reject) => {
          timeout = setTimeout(() => { controller?.abort(); reject(new Error('memory consolidate timeout')); }, TIMEOUT_MS);
          timeout.unref?.();
        }),
      ]);
      if (stopped || signal.aborted || !['stop', 'length'].includes(response?.stopReason)) return;
      const summary = (response.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
      if (summary) appendMemorySummary(dir, cwd, summary);
    } catch {
      // Best effort only; never redirect failed project writes to shared memory.
    } finally {
      clearTimeout(timeout);
      controller = undefined;
      inFlight = false;
    }
  };

  pi.on('agent_end', (_event, ctx) => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void consolidate(ctx); }, DEBOUNCE_MS);
    timer.unref?.();
  });
  pi.on('session_shutdown', () => {
    stopped = true;
    if (timer) { clearTimeout(timer); timer = null; }
    controller?.abort();
  });
}
