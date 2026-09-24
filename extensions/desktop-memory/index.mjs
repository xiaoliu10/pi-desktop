/**
 * Desktop 记忆桥接扩展：对话轮结束后自动整理记忆（对齐 ZCode 的自动记忆体验）。
 *
 * 装载：Desktop 启动会话时以 -e 挂载，env 开关：
 *   PI_DESKTOP_MEMORY=1            开启自动整理
 *   PI_DESKTOP_MEMORY_DIR=<dir>    目标记忆目录（桥接到当前生效记忆插件的目录）
 *
 * 行为（复刻 pi-memory exit summary 的机制，但触发点是每轮对话完成而非进程退出）：
 *   agent_end → 防抖静默期后 → 会话消息 ≥4 条 → 直接 LLM 摘要（low reasoning，
 *   不进对话流）→ 以 pi-memory 日志格式追加到 <dir>/daily/YYYY-MM-DD.md。
 * 单飞行 + 冷却，失败静默（不干扰会话）。用户已装记忆插件时写入其目录沿用其格式；
 * 未装时写同一默认目录（pi-memory 安装后立即可见）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MIN_MESSAGES = 4;
const DEBOUNCE_MS = 20_000; // agent_end 后静默 20s（连续轮次只整理最后一次）
const COOLDOWN_MS = 120_000; // 两次整理最小间隔
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
    '### Decisions',
    '### Lessons Learned',
    '### Notes',
    '### Follow-ups',
    'Use bullet points under each heading. If there is nothing, write "None.".',
  ];
  if (truncated) lines.push(`Note: Conversation transcript was truncated to the most recent ${conversationText.length} of ${totalChars} characters.`);
  lines.push('', '<conversation>', conversationText, '</conversation>');
  return lines.join('\n');
}

/** 定位 @earendil-works/pi-ai（ESM-only，需按路径动态 import）：从 pi CLI 入口向上找 node_modules。 */
async function loadComplete() {
  const { createRequire } = await import('node:module');
  const { pathToFileURL } = await import('node:url');
  const require = createRequire(process.argv[1] || import.meta.url);
  let pkgDir = '';
  try {
    pkgDir = require.resolve('@earendil-works/pi-ai').replace(/(dist[\\/])?index\.js$/, '').replace(/package\.json$/, '');
  } catch {
    // fallback：手动沿 argv[1] 向上走 node_modules
    let dir = path.dirname(process.argv[1] || '.');
    for (let i = 0; i < 8 && !pkgDir; i += 1) {
      const candidate = path.join(dir, 'node_modules', '@earendil-works', 'pi-ai');
      try { fs.accessSync(path.join(candidate, 'package.json')); pkgDir = candidate; } catch { dir = path.dirname(dir); }
    }
  }
  if (!pkgDir) throw new Error('pi-ai 不可用');
  const mod = await import(pathToFileURL(path.join(pkgDir, 'dist', 'compat.js')).href);
  if (typeof mod.complete !== 'function') throw new Error('pi-ai complete 不可用');
  return mod.complete;
}

function serializeConversation(messages) {
  const parts = [];
  for (const message of messages) {
    const role = message.role === 'assistant' ? 'Assistant' : message.role === 'toolResult' ? 'Tool' : 'User';
    const content = message.content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n')
      .trim();
    if (text) parts.push(`${role}: ${text}`);
  }
  return parts.join('\n\n');
}

export default function desktopMemory(pi) {
  if (process.env.PI_DESKTOP_MEMORY !== '1') return;
  const dir = process.env.PI_DESKTOP_MEMORY_DIR || path.join(os.homedir(), '.pi', 'agent', 'memory');
  let timer = null;
  let lastRunAt = 0;
  let inFlight = false;

  const appendDaily = (text) => {
    const daily = path.join(dir, 'daily');
    fs.mkdirSync(daily, { recursive: true });
    const file = path.join(daily, `${new Date().toISOString().slice(0, 10)}.md`);
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const entry = [`<!-- ${stamp} [desktop-auto] -->`, '## Turn Summary (auto, desktop)', '', text.trim(), ''].join('\n');
    fs.appendFileSync(file, entry, 'utf8');
  };

  const consolidate = async (ctx) => {
    if (inFlight || Date.now() - lastRunAt < COOLDOWN_MS) return;
    if (!ctx.isIdle?.() || ctx.hasPendingMessages?.()) return;
    const branch = ctx.sessionManager?.getBranch?.();
    const messages = Array.isArray(branch)
      ? branch.filter((e) => e?.type === 'message').map((e) => e.message).filter(Boolean)
      : [];
    if (messages.length < MIN_MESSAGES) return;
    const model = ctx.model;
    if (!model) return;
    let apiKey;
    try { apiKey = await ctx.modelRegistry?.getApiKey?.(model); } catch { /* 不可解析则跳过 */ }
    if (!apiKey) return;
    const conversationText = serializeConversation(messages);
    if (!conversationText.trim()) return;
    const truncated = conversationText.length > MAX_CONVERSATION_CHARS;
    const text = truncated ? conversationText.slice(-MAX_CONVERSATION_CHARS) : conversationText;
    inFlight = true;
    lastRunAt = Date.now();
    const timeout = setTimeout(() => { /* 兜底：完成标志由 finally 释放 */ }, TIMEOUT_MS);
    timeout.unref?.();
    try {
      const complete = await loadComplete();
      const response = await Promise.race([
        complete(model, { systemPrompt: SYSTEM_PROMPT, messages: [{ role: 'user', content: [{ type: 'text', text: buildPrompt(text, truncated, conversationText.length) }], timestamp: Date.now() }] }, { apiKey, reasoningEffort: 'low' }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('memory consolidate timeout')), TIMEOUT_MS)),
      ]);
      const summary = (response?.content ?? [])
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('\n')
        .trim();
      if (summary) appendDaily(summary);
    } catch {
      // 静默：记忆整理是尽力而为的后台动作，不打扰会话
    } finally {
      clearTimeout(timeout);
      inFlight = false;
    }
  };

  pi.on('agent_end', (_event, ctx) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void consolidate(ctx); }, DEBOUNCE_MS);
    timer.unref?.();
  });
  pi.on('session_shutdown', () => { if (timer) { clearTimeout(timer); timer = null; } });
}
