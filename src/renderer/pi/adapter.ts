import { contextPrompt, parseContextPrompt, type ContextItem, type ThinkingLevel } from '../../shared/composer';
import { closeTransientPopovers } from '../replica/popovers';
import { applyAssistantStreamDelta } from './stream-delta';
import { type AccessMode } from '../../shared/access-mode';
import type { DesktopPreferences } from '../../shared/settings';
import type { SettingsNavId } from '../replica/contracts';
/**
 * Real-data adapter (P08 integration): binds the accepted replica UI
 * contracts to the local pi backend exposed on `window.localPi`.
 *
 * The demo preview keeps its own fixture adapter (src/renderer/preview).
 * Everything here is derived from the pi host: sessions, JSONL history,
 * RPC streaming events, models, resources and workspace review. Pure
 * mapping helpers are exported for tests.
 */

import { create } from 'zustand';
import {
  createNavHistory,
  canGoBack as navCanGoBack,
  canGoForward as navCanGoForward,
  navBack as navHistoryBack,
  navForward as navHistoryForward,
  pushNavEntry,
  type NavEntry,
  type NavHistory,
} from './navigation-history';
import type {
  ChatMessage,
  DemoFileDiff,
  MessagePart,
  ModelGroup,
  NotificationItem,
  PluginRowData,
  ProjectNavItem,
  SessionNavItem,
} from '../replica/contracts';
import type { LocalPiApi, PiEntry, PiEvent, PiEnvironment, PiHistory, PiModelCatalog, PiResource, PiReview, PiRun, PiSession, PiUiRequest } from '../../shared/pi';

export type Dialog = { key: string; generation: string; request: PiUiRequest };
export type Behavior = 'steer' | 'followUp';

declare global {
  interface Window {
    localPi: LocalPiApi;
  }
}

// ---------------------------------------------------------------------------
// Pure mapping helpers (unit-tested)
// ---------------------------------------------------------------------------

const clean = (value: unknown): string =>
  String(value ?? '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '');

function contentText(content: unknown): string {
  return typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.filter((b) => b?.type === 'text').map((b) => String(b.text ?? '')).join('\n')
      : '';
}

/** Basename of a path, tolerant of separators. */
export function pathBase(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).at(-1) || p;
}

export interface ToolProgress {
  turnId?: string;
  /** Message active when this tool first appeared (survives summary-only end). */
  messageId?: string;
  details?: unknown;
  detailsFinal?: boolean;
  phase?: "progress" | "result";
  toolCallId: string;
  name: string;
  text: string;
  status: 'running' | 'done' | 'error';
  /** JSON args string (from tool_execution_start raw.args) so running tools can show
   *  a clickable file link + line-change stat before the result lands. */
  argumentsText?: string;
}

/** Convert pi history branch entries into replica chat messages. */
function messageTime(value: unknown): number | undefined {
  const time = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? time : undefined;
}

// pi 的 jsonl entry 是 append-only 的（id 稳定、内容不可变）。缓存必须按 entry.id
// 而不是对象身份：refreshHistory 走 IPC 结构化克隆后所有 entry 都是新对象，按身份
// 缓存会 100% 失效 → 每次刷新全量重建 + 全量重渲染（千条会话秒级卡死）。
const messageCache = new Map<string, ChatMessage>();

export function historyToMessages(branch: PiEntry[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  // thunk 形式：缓存命中时连构造都跳过（工具参数 JSON.stringify、工具结果全文 clean 是主要开销）。
  // 仅 entry.id（稳定 uuid）可作缓存键；无 id 的条目走 index 兜底，切分支会串位，不缓存。
  const push = (entry: PiEntry, id: string, build: () => ChatMessage | undefined) => {
    // id + 落盘时间做键：entry append-only 内容不可变；合成/测试数据可能复用 id，
    // 带上 timestamp 指纹避免跨分支误命中。
    const stable = entry.id ? `${entry.id}:${(entry.timestamp as string | number | undefined) ?? ''}` : undefined;
    if (stable) {
      const hit = messageCache.get(stable);
      if (hit) { out.push(hit); return; }
      if (messageCache.size > 30_000) messageCache.clear();
      const built = build();
      if (!built) return;
      messageCache.set(stable, built);
      out.push(built);
      return;
    }
    const msg = build();
    if (msg) out.push(msg);
  };
  let prevAt: number | undefined;
  branch.forEach((entry, index) => {
    const id = String(entry.id ?? `entry-${index}`);
    if (entry.type === 'message' && entry.message) {
      const m = entry.message as Record<string, unknown>;
      const role = String(m.role ?? '');
      // Entry timestamps are recorded when a completed message is appended.
      const timestamp = messageTime(entry.timestamp) ?? messageTime(m.timestamp);
      // 「思考 · 用时 N 秒」的时长：与上一条落盘消息的时间差近似生成耗时。
      const sincePrevMs = prevAt !== undefined && timestamp !== undefined ? Math.max(0, timestamp - prevAt) : undefined;
      if (timestamp !== undefined) prevAt = timestamp;
      const content = m.content;
      if (role === 'user') {
        const text = contentText(content);
        push(entry, id, () => ({ id, timestamp, role: 'user', parts: [{ kind: 'text', id: `${id}-t`, text }, ...(Array.isArray(content) ? content.flatMap((b: any, i: number): MessagePart[] => b.type === 'image' && typeof b.data === 'string' && /^image\/(png|jpeg|webp|gif)$/.test(b.mimeType) ? [{kind:'image',id:`${id}-image-${i}`,data:b.data,mimeType:b.mimeType}] : []) : [])] }));
        return;
      }
      if (role === 'assistant') {
        push(entry, id, () => {
          const parts: MessagePart[] = [];
          let firstThinking = true;
          if (typeof content === 'string') parts.push({ kind: 'text', id: `${id}-t`, text: content });
          if (Array.isArray(content)) {
            for (const [index, block] of content.entries()) {
              if (block?.type === 'text') parts.push({ kind: 'text', id: `${id}-text-${index}`, text: clean(block.text) });
              if (block?.type === 'thinking' && block.thinking) {
                parts.push({ kind: 'thinking', id: `${String(m.timestamp ?? id)}-thinking-${index}`, text: clean(block.thinking), ...(firstThinking && sincePrevMs !== undefined ? { durationMs: sincePrevMs } : {}) });
                firstThinking = false;
              }
              if (block?.type === 'toolCall') {
                const args = JSON.stringify((block as { arguments?: unknown }).arguments ?? {}, null, 2);
                parts.push({
                  kind: 'tool',
                  id: `${id}-${String((block as { id?: string }).id ?? parts.length)}`,
                  callId: typeof block.id === 'string' ? block.id : undefined, phase: 'call', argumentsText: clean(args),
                  tool: String((block as { name?: string }).name ?? 'tool'),
                  summary: clean(args).slice(0, 80),
                  status: 'done',
                  detailLines: [clean(args)],
                });
              }
            }
          }
          if ((m as { errorMessage?: string }).errorMessage) {
            parts.push({ kind: 'error', id: `${id}-err`, message: clean((m as { errorMessage?: string }).errorMessage) });
          }
          if (!parts.length) return undefined;
          return { id, timestamp, role: 'assistant' as const, parts, model: (m as { model?: unknown }).model ? clean((m as { model?: { id?: unknown } }).model?.id) : undefined };
        });
        return;
      }
      if (role === 'toolResult') {
        push(entry, id, () => {
          const text = contentText(content);
          const firstLine = clean(text).split('\n')[0] ?? '';
          return {
            id, timestamp,
            role: 'assistant' as const,
            parts: [
              {
                kind: 'tool',
                resultDetails:m.details, resultDetailsFinal:!!m.details, id: `${id}-result`, callId: typeof m.toolCallId === 'string' ? m.toolCallId : undefined, phase: 'result',
                tool: clean((m as { toolName?: string }).toolName ?? 'tool'),
                summary: firstLine.slice(0, 80),
                status: (m as { isError?: boolean }).isError ? 'error' : 'done',
                detailLines: [clean(text) || '(无文本输出)'],
              },
            ],
          };
        });
        return;
      }
      return;
    }
    if (['compaction', 'branch_summary'].includes(entry.type)) {
      push(entry, id, () => ({
        id,
        role: 'assistant',
        parts: [{ kind: 'notice', id: `${id}-n`, text: entry.type === 'compaction' ? '上下文压缩记录' : '分支摘要' }],
      }));
      return;
    }
    if (entry.customType === 'desktop-policy-audit') return;
    if (['custom', 'custom_message'].includes(entry.type)) {
      push(entry, id, () => ({
        id,
        role: 'assistant',
        parts: [{ kind: 'notice', id: `${id}-n`, text: `扩展记录 · ${clean((entry as { customType?: string }).customType ?? entry.type)}` }],
      }));
    }
  });
  return out;
}

/** ToolProgress → tool 部件（尾部追加与归位拼接共用同一份映射）。 */
function progressToPart(t: ToolProgress): MessagePart {
  return {
    kind: 'tool' as const,
    id: `prog-${t.toolCallId}`, callId: t.toolCallId, phase: t.phase??'progress', resultDetails:t.details, resultDetailsFinal:t.detailsFinal, argumentsText: t.argumentsText,
    tool: t.name,
    summary: t.text.slice(0, 80),
    status: t.status,
    detailLines: [t.text],
  };
}

/** Live (not yet persisted) streaming assistant messages + tool progress. */
export function liveToMessages(
  live: Record<string, Record<string, unknown>> | undefined,
  tools: ToolProgress[] | undefined,
): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const [id, m] of Object.entries(live ?? {})) {
    const parts: MessagePart[] = [];
    if (typeof m.content === 'string') parts.push({ kind: 'text', id: `${id}-t`, text: clean(m.content) });
    if (Array.isArray((m as { content?: unknown }).content)) {
      for (const [index, block] of (m as { content: Array<Record<string, unknown>> }).content.entries()) {
        if (block?.type === 'text') parts.push({ kind: 'text', id: `${id}-text-${index}`, text: clean(block.text) });
        if (block?.type === 'thinking' && block.thinking) parts.push({ kind: 'thinking', id: `${String(m.timestamp ?? id)}-thinking-${index}`, text: clean(block.thinking) });
        if (block?.type === 'toolCall') {
          parts.push({
            kind: 'tool',
            id: `${id}-${String(block.id ?? parts.length)}`,
            callId: typeof block.id === 'string' ? block.id : undefined, phase: 'call', argumentsText: clean(JSON.stringify(block.arguments ?? {}, null, 2)),
            tool: String(block.name ?? 'tool'),
            summary: clean(JSON.stringify(block.arguments ?? {})).slice(0, 80),
            status: 'running',
          });
        }
      }
    }
    if (parts.length) out.push({ id: `live-${id}`, role: 'assistant', timestamp: messageTime(m.timestamp), parts });
  }
  if (tools?.length) {
    out.push({
      id: 'live-tools',
      role: 'assistant',
      parts: tools.map(progressToPart),
    });
  }
  return out;
}


export function conversationMessages(branch: PiEntry[], live: Record<string, Record<string, unknown>> | undefined, tools: ToolProgress[] | undefined): ChatMessage[] {
  const saved = new Set(branch.filter(e => e.message?.role === 'assistant').map(e => String(e.message?.timestamp)));
  const pending = Object.fromEntries(Object.entries(live || {}).filter(([id]) => !saved.has(id)));
  const history = historyToMessages(branch);
  const liveMessages = liveToMessages(pending, undefined);
  // 上一轮答案还在 live（agent_settled 的防抖刷新未落地）而新用户消息已落盘时，
  // 按数组拼接会把旧答案排到新消息之后。把带时间戳的 live 消息插入到历史中比它
  // 晚的第一条之前；无时间戳的 live 与历史本身保持原序（兼容旧行为）。
  const merged = [...history];
  for (const lm of liveMessages) {
    if (lm.timestamp === undefined) { merged.push(lm); continue; }
    let at = merged.length;
    let seenLaterDated = false;
    for (let i = merged.length - 1; i >= 0; i -= 1) {
      const mt = merged[i]!.timestamp;
      // 无时间戳条目（用户消息常见）：只有后面还没遇到更晚的带时间戳条目时才越过它，
      // 否则该无时间戳条目属于更早位置，live 应插在它与后续带时间戳条目之间。
      if (mt === undefined) { if (!seenLaterDated) at = i; continue; }
      if (mt > lm.timestamp) { at = i; seenLaterDated = true; } else break;
    }
    merged.splice(at, 0, lm);
  }
  if (!tools?.length) return merged;
  // 工具进度按 toolCallId 归位，而不是无条件整份追加到末尾（那样旧轮次残留的
  // progress/result 会被挂到新的用户消息之后）：
  // 1. 历史已落盘同 callId 的 result → 已保存结果优先，残留 progress 直接丢弃；
  // 2. 历史/实时消息里只有 call 没有 result → 把未落盘的 progress/result 拼回原始
  //    调用所在消息（保持旧轮次位置，由 executionTurns 按 callId 去重合并）；
  // 3. 完全不认识的 callId（新一轮实时工具，call 块尚未流出）→ 追加到末尾。
  const savedResults = new Set<string>();
  const callAt = new Map<string, ChatMessage>();
  const index = (messages: ChatMessage[], historical: boolean) => {
    for (const msg of messages) {
      for (const part of msg.parts) {
        if (part.kind !== 'tool' || !part.callId) continue;
        if (part.phase === 'result') { if (historical) savedResults.add(part.callId); }
        else if (!callAt.has(part.callId)) callAt.set(part.callId, msg);
      }
    }
  };
  index(history, true);
  index(liveMessages, false);
  // 按消息对象身份归位，不依赖数组下标（插入/排序都不影响）。
  const splices = new Map<ChatMessage, MessagePart[]>();
  const trailing: ToolProgress[] = [];
  const leading = new Map<ChatMessage, MessagePart[]>();
  for (const t of tools) {
    if (savedResults.has(t.toolCallId)) continue;
    const msg = callAt.get(t.toolCallId);
    if (!msg) {
      const anchor = t.messageId && merged.find(m => m.id === `live-${t.messageId}` || String(m.timestamp) === t.messageId);
      if (anchor) leading.set(anchor, [...(leading.get(anchor) ?? []), progressToPart(t)]);
      else trailing.push(t);
      continue;
    }
    const list = splices.get(msg) ?? [];
    list.push(progressToPart(t));
    splices.set(msg, list);
  }
  // 只给被拼入的消息换新对象，其余消息保持缓存身份（turn 级 memo 依赖它）。
  const placed = splices.size || leading.size
    ? merged.map((m) => (splices.has(m) || leading.has(m) ? { ...m, parts: [...(leading.get(m) ?? []), ...m.parts, ...(splices.get(m) ?? [])] } : m))
    : merged;
  return [...placed, ...liveToMessages(undefined, trailing)];
}

/** Parse a unified `git diff` text into per-file replica diffs. */
export function parseUnifiedDiff(text: string): DemoFileDiff[] {
  const files: DemoFileDiff[] = [];
  let cur: DemoFileDiff | null = null;
  let created = false;
  let previousPath = '';
  let oldLine: number | undefined, newLine: number | undefined;
  const finish = () => {
    if (cur) files.push(cur);
    cur = null;
  };
  for (const raw of text.split('\n')) {
    if (raw.startsWith('diff --git')) {
      finish();
      continue;
    }
    if (raw.startsWith('--- ')) {
      previousPath = raw.slice(4).replace(/^a\//, '');
      created = raw.includes('/dev/null');
      continue;
    }
    if (raw.startsWith('+++ ')) {
      const path = raw.slice(4).replace(/^b\//, '');
      cur = { path: path === '/dev/null' ? previousPath : path, created, additions: 0, deletions: 0, lines: [] };
      continue;
    }
    if (!cur) continue;
    if (raw.startsWith('@@')) {
      // @@ -a,b +c,d @@ → 旧/新文件行号从这里起算（删=旧号，增/上下文=新号）。
      const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); }
      continue;
    }
    if (raw.startsWith('+')) {
      cur.additions++;
      cur.lines.push({ type: '+', text: raw.slice(1), line: newLine });
      if (newLine !== undefined) newLine++;
    } else if (raw.startsWith('-')) {
      cur.deletions++;
      cur.lines.push({ type: '-', text: raw.slice(1), line: oldLine });
      if (oldLine !== undefined) oldLine++;
    } else if (raw.startsWith(' ')) {
      cur.lines.push({ type: ' ', text: raw.slice(1), line: newLine });
      if (newLine !== undefined) newLine++;
      if (oldLine !== undefined) oldLine++;
    } else if (raw.startsWith('Binary files') || raw.startsWith('GIT binary patch')) {
      cur.lines.push({ type: ' ', text: raw });
    }
  }
  finish();
  return files.filter((f) => f.path !== '(deleted)');
}

/** Tracked diff entries plus untracked files as created entries, deduped by path. */
export function reviewDiffEntries(review: PiReview): DemoFileDiff[] {
  const tracked = parseUnifiedDiff(review.diff);
  const seen = new Set(tracked.map((f) => f.path));
  const created = (review.untrackedFiles ?? [])
    .filter((f) => f && typeof f.path === 'string' && !seen.has(f.path))
    .map((f) => ({ path: f.path, created: true, additions: Math.max(0, f.lines | 0), deletions: 0, lines: [] }));
  return [...tracked, ...created];
}

/** Map discovered pi resources onto the replica plugin rows (honestly). */
export function resourcesToPluginRows(resources: PiResource[]): PluginRowData[] {
  return resources.map((r) => ({
    id: r.id,
    name: r.name,
    packageId: r.kind,
    version: '',
    status:
      r.status === 'callable'
        ? 'active'
        : r.status === 'error'
          ? 'attention'
          : r.status === 'discovered'
            ? 'updatable'
            : 'off',
    scope: r.scope === 'user' ? 'everywhere' : 'project',
    error: r.status === 'error' ? r.detail : undefined,
    badge: r.scope === 'user' ? '全局' : '项目',
    details: [r.detail, r.path],
  }));
}

/** Group pi models by provider for the composer model menu. */
export function groupModels(run: PiRun | undefined): ModelGroup[] {
  const byProvider = new Map<string, ModelGroup>();
  for (const m of run?.models ?? []) {
    let group = byProvider.get(m.provider);
    if (!group) {
      group = { provider: m.provider, models: [] };
      byProvider.set(m.provider, group);
    }
    group.models.push({ id: `${m.provider}/${m.id}`, name: m.name, detail: m.id });
  }
  return [...byProvider.values()];
}

/** Build sidebar navigation from pi sessions + active runs. */
export function buildPiSidebar(
  sessions: PiSession[],
  runs: PiRun[],
  expanded: string[],
  renames: Record<string, string>,
): { temporary: SessionNavItem[]; projects: ProjectNavItem[] } {
  const runByKey = new Map(runs.map((r) => [r.key, r]));
  const byCwd = new Map<string, PiSession[]>();
  for (const s of sessions) {
    const list = byCwd.get(s.cwd) ?? [];
    list.push(s);
    byCwd.set(s.cwd, list);
  }
  const projects: ProjectNavItem[] = [...byCwd.entries()]
    .map(([cwd, list]) => ({
      id: cwd,
      name: pathBase(cwd),
      path: cwd,
      expanded: expanded.includes(cwd),
      emptyHint: false,
      sessions: list
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((s) => ({
          id: s.key,
          title: renames[s.key] ?? s.name,
          updatedAt: s.updatedAt,
          source: s.owned ? ('desktop' as const) : ('pi-cli' as const),
          syncedAt: undefined,
          canContinue: !s.owned && !runByKey.has(s.key),
          busy: ['running', 'starting'].includes(runByKey.get(s.key)?.status ?? ''),
          cwd: s.cwd,
          path: s.path,
        })),
    }))
    .sort((a, b) => {
      const am = Math.max(...(byCwd.get(a.id) ?? []).map((s) => s.updatedAt), 0);
      const bm = Math.max(...(byCwd.get(b.id) ?? []).map((s) => s.updatedAt), 0);
      return bm - am;
    });
  // Desktop runs whose session file has not appeared yet.
  const orphanRuns: SessionNavItem[] = runs
    .filter((r) => !sessions.some((s) => s.key === r.key))
    .map((r) => ({
      id: r.key,
      title: '新桌面会话',
      updatedAt: Date.now(),
      source: 'desktop' as const,
      busy: r.status === 'running' || r.status === 'starting',
    }));
  return { temporary: orphanRuns, projects };
}

export interface OptimisticSend {
  id: string;
  key: string | null;
  at: number;
  text: string;
  images: import('../../shared/composer').PiImage[];
  baseline: string[];
  confirmedId?: string;
}

/** Never acknowledge against a pre-send entry (including identical text/timestamps). */
export function confirmSends(sends: OptimisticSend[], history: PiHistory, key: string): OptimisticSend[] {
  const claimed = new Set(sends.flatMap(s => s.confirmedId ? [s.confirmedId] : []));
  return sends.map(s => {
    if (s.key !== key || s.confirmedId) return s;
    const entry = history.branch.find(e => {
      if (!e.id || s.baseline.includes(e.id) || claimed.has(e.id) || e.message?.role !== 'user') return false;
      const content = e.message.content;
      const images = Array.isArray(content) ? content.filter((b: any) => b.type === 'image') : [];
      return contentText(content) === s.text && images.length === s.images.length && images.every((b: any, i: number) => b.data === s.images[i].data && b.mimeType === s.images[i].mimeType);
    });
    if (!entry?.id) return s;
    claimed.add(entry.id);
    return { ...s, confirmedId: entry.id };
  });
}

/** Split at explicit send boundaries, not wall-clock guesses. Old live stays before the new user. */
export function sentConversationMessages(branch: PiEntry[], live: Record<string, Record<string, unknown>> | undefined, tools: ToolProgress[] | undefined, sends: OptimisticSend[]): ChatMessage[] {
  // Every persisted user is a boundary, including consumed follow-up/steer
  // items (which intentionally have no optimistic send). Missing confirmed
  // boundaries remain absent: their transient work is quarantined in state,
  // never appended to a different branch. Persisted history is always retained.
  const confirmed = new Map(sends.filter(s => s.confirmedId).map(s => [s.confirmedId, s]));
  sends = [
    ...branch.filter(e => e.message?.role === 'user' && e.id).map(e => confirmed.get(e.id) ?? {
      id: `history:${e.id}`, confirmedId: e.id, key: null, at: 0,
      text: '', images: [], baseline: [],
    }),
    ...sends.filter(s => !s.confirmedId),
  ];
  const out: ChatMessage[] = [];
  let cursor = 0;
  // A late result/update may arrive after its progress was retired. Persisted
  // call identity outranks the current event turn, otherwise old work resurfaces
  // after the new user despite having already been saved in an earlier segment.
  const toolOwners = new Map<string, string | undefined>();
  const boundaries = new Map(sends.filter(s => s.confirmedId).map(s => [s.confirmedId, s.id]));
  let historyOwner: string | undefined;
  for (const entry of branch) {
    if (entry.id && boundaries.has(entry.id)) historyOwner = boundaries.get(entry.id);
    const message = entry.message;
    if (typeof message?.toolCallId === 'string' && !toolOwners.has(message.toolCallId)) toolOwners.set(message.toolCallId, historyOwner);
    if (Array.isArray(message?.content)) for (const block of message.content) {
      if (block.type === 'toolCall' && typeof block.id === 'string' && !toolOwners.has(block.id)) toolOwners.set(block.id, historyOwner);
    }
  }
  // A tool call may still exist only in an older live message when its first
  // execution event arrives. Its message identity outranks event arrival too.
  for (const message of Object.values(live ?? {})) {
    if (Array.isArray(message.content)) for (const block of message.content) {
      if (block.type === 'toolCall' && typeof block.id === 'string' && !toolOwners.has(block.id)) toolOwners.set(block.id, message._turnId as string | undefined);
    }
  }
  // Saved message identity also outranks event arrival order. Suppress saved
  // live copies globally, not per segment (a late end may have a stale owner).
  const savedMessages = new Set(branch.filter(e => e.message?.role === 'assistant').map(e => String(e.message?.timestamp ?? e.message?.id)));
  const segment = (entries: PiEntry[], owner?: string) => conversationMessages(entries,
    Object.fromEntries(Object.entries(live ?? {}).filter(([id, m]) => !savedMessages.has(id) && m._turnId === owner)),
    (tools ?? []).filter(t => (toolOwners.has(t.toolCallId) ? toolOwners.get(t.toolCallId) : t.turnId) === owner)).map(m => m.id === 'live-tools' ? { ...m, id: `live-tools:${owner ?? 'initial'}` } : m);
  for (let i = 0; i < sends.length; i++) {
    const send = sends[i];
    const at = send.confirmedId ? branch.findIndex(e => e.id === send.confirmedId) : -1;
    // While history is late, everything already saved still belongs before this send.
    const end = at >= cursor ? at : branch.length;
    out.push(...segment(branch.slice(cursor, end), sends[i - 1]?.id));
    if (send.id.startsWith('history:') && at >= 0) out.push(...historyToMessages([branch[at]]));
    else out.push({ id: send.id, role: 'user', timestamp: send.at, parts: [
      { kind: 'text', id: `${send.id}-text`, text: send.text },
      ...send.images.map((image, n) => ({ ...image, kind: 'image' as const, id: `${send.id}-image-${n}` })),
    ] });
    cursor = at >= cursor ? at + 1 : end;
  }
  out.push(...segment(branch.slice(cursor), sends.at(-1)?.id));
  return out;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface PiUiPrefs {
  lang: 'en' | 'zh';
  theme: 'light' | 'dark';
  fontScale: number;
  font: string;
}

const PREFS_KEY = 'pi-ui:prefs';

function loadPrefs(): PiUiPrefs {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (raw) return { lang: 'zh', theme: 'light', fontScale: 100, font: 'System default', ...(JSON.parse(raw) as Partial<PiUiPrefs>) };
  } catch {
    /* ignore */
  }
  return { lang: 'zh', theme: 'light', fontScale: 100, font: 'System default' };
}

function savePrefs(prefs: PiUiPrefs): void {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}

export interface PiReplicaState {
  ready: boolean;
  env?: PiEnvironment;
  sessions: PiSession[];
  archivedKeys: string[];
  runs: PiRun[];
  resources: PiResource[];
  piPackages: import('../../shared/pi').PiInstalledPackage[];
  market: import('../../shared/pi').PiMarketPackage[];
  marketQuery: string;
  marketLoading: boolean;
  /** 市场封面候选 URL，按包名缓存（异步加载，搜索返回后填充）。 */
  covers: Record<string, string[]>;
  packageBusy?: string;
  catalog?: PiModelCatalog;
  catalogLoading: boolean;

  selectedKey: string | null;
  history?: PiHistory;
  leaf?: string;
  titles: Record<string, string>;
  renames: Record<string, string>;

  view: 'home' | 'chat' | 'plugins' | 'settings' | 'automations';
  /** 浏览器式前进/后退历史（复刻 ZCode taskNavigationHistory），见 navigation-history.ts。 */
  navHistory: NavHistory;
  /** 自动化“立即运行”的乐观气泡：点击瞬间就进对话，pi 会话建立后无缝切换。 */
  automationLaunch?: { name: string; prompt: string; startedAt: number; sessionKey?: string };
  settingsPage: SettingsNavId;
  desktopPreferences?: DesktopPreferences;
  sidebarCollapsed: boolean;
  expandedProjects: string[];

  lang: 'en' | 'zh';
  theme: 'light' | 'dark';
  fontScale: number;
  font: string;
  behavior: Behavior;
  draftText: string;
  contextItems: ContextItem[];
  draftModelId?: string;
  draftThinking?: ThinkingLevel;
  pendingPrompt?: string;
  /** Client identities survive IPC acknowledgement and history replacement. */
  sends?: OptimisticSend[];
  /** Pending prompt identity; acknowledgement uses baseline IDs and content. */
  pendingPromptAt?: number;
  /** 「立即」插入的乐观 steer 气泡（按会话）：真实用户条目落盘后由 settle 交换。 */
  pendingSteer?: Record<string, { text: string; at: number; baseline: string[]; images: import('../../shared/composer').PiImage[] }>;
  /** 最近一次发送的时间点（按会话记）：pi 应答 prompt 到 agent_start 之间界面也能立刻计时。 */
  sentAt?: { key: string; at: number };
  /** 父会话重启后从磁盘恢复的子代理进度（扩展在 onUpdate 时持久化的快照）。 */
  recoveredSubagents?: Array<{ callId: string; status: string; details?: unknown; error?: string; startedAt?: number; updatedAt?: number }>;
  /** 已被用户从子代理目录移除的 callId（仅当前会话内存态，切会话清空）。 */
  subagentDismissed?: string[];
  /** pi 全局 settings.json 的 AI 默认值（通用设置页内联展示与保存）。 */
  aiSettings?: import('../../shared/settings').SettingsSnapshot['ai'];
  draftCwd?: string;
  draftAccessMode?: AccessMode;
  previousExecutionMode?: Exclude<AccessMode, 'plan'>;
  changingAccessMode: boolean;

  connecting: boolean;
  addingProject: boolean;
  paths: { runtime: 'auto' | 'bundled' | 'system' | 'custom'; executable: string; agentDir: string; sessionDirs: string };

  workbenchOpen: boolean;
  workbenchTab: 'review' | 'files' | 'browser';
  review?: PiReview;
  reviewLoading: boolean;

  searchOpen: boolean;
  searchQuery: string;
  notificationsOpen: boolean;
  notifications: NotificationItem[];
  notice?: string;
  error?: string;

  dialogs: Dialog[];
  live: Record<string, Record<string, Record<string, unknown>>>;
  toolProgress: Record<string, ToolProgress[]>;
  /** Per-run retry state (auto_retry_start…auto_retry_end): drives the working-bar
   *  "正在重试请求" label so a silent timeout-retry window doesn't look frozen. */
  retrying: Record<string, { attempt: number; max: number } | null>;
  widgets: Record<string, Record<string, string>>;

  resetCounter: number;
}

export interface PiReplicaActions {
  init: () => void;
  /** 前进/后退（浏览器式历史回放，不产生新的历史条目）。 */
  navBack: () => void;
  navForward: () => void;
  /** 自动化立即运行：先乐观切入对话（预览气泡），会话就绪后切换过去。 */
  runAutomationNow: (task: { id: string; name: string; previewPrompt: string }) => void;
  navigate: (view: PiReplicaState['view']) => void;
  openSettings: (page: PiReplicaState['settingsPage']) => void;
  backToApp: () => void;
  toggleSidebar: () => void;
  toggleProject: (cwd: string) => void;
  selectSession: (key: string) => void;
  dismissSubagent: (callId: string) => void;
  dismissFinishedSubagents: (callIds: string[]) => void;
  setSessionArchived: (key: string, archived: boolean) => Promise<boolean>;
  /** 删除归档会话（文件进系统废纸篓）：成功后从归档列表与会话索引移除。 */
  deleteArchivedSession: (key: string) => Promise<boolean>;
  setDraftText: (text: string) => void;
  send: (text: string) => void;
  /** 编辑已发送消息：先 fork 截断回该条目，再走普通发送。失败时报错且不发送。 */
  resendEdited: (entryId: string, text: string) => Promise<void>;
  stop: () => void;
  queueEdit: (op: import('../../shared/pi').PiQueueOp) => void;
  /** Recall a queued prompt into the composer (text + image attachments) for editing. */
  queueRecall: (index: number) => void;
  pickModel: (combinedId: string) => void;
  pickThinking: (level: ThinkingLevel) => void;
  addContext: (items: ContextItem[]) => void;
  removeContext: (id: string) => void;
  reloadExtensions: () => void;
  disconnect: () => void;
  renameSession: (key: string, name: string) => void;
  startContinueCopy: (sourceKey: string) => void;
  startNewSession: () => void;
  chooseWorkspace: () => void;
  setAccessMode: (mode: AccessMode) => Promise<boolean>;
  executePlan: (feedback?: string) => void;
  declinePlan: (feedback?: string) => void;
  addProject: () => void;
  setTheme: (t: 'light' | 'dark') => void;
  setLang: (l: 'en' | 'zh') => void;
  setFontScale: (n: number) => void;
  setFont: (f: string) => void;
  toggleWorkbench: () => void;
  selectWorkbenchTab: (tab: 'review' | 'files' | 'browser') => void;
  setSearchOpen: (open: boolean) => void;
  setSearchQuery: (q: string) => void;
  toggleNotifications: () => void;
  markAllRead: () => void;
  dismissError: () => void;
  dismissNotice: () => void;
  answerDialog: (response: { id: string; value?: string; confirmed?: boolean; cancelled?: boolean }) => void;
  scanResources: () => void;
  rescanAndReload: () => void;
  loadCatalog: () => void;
  loadPackages: () => void;
  searchMarketplace: (query: string) => void;
  installPackage: (spec: string) => void;
  removePackage: (spec: string) => void;
  registerPackage: (spec: string) => void;
  savePaths: () => void;
  setPaths: (patch: Partial<PiReplicaState['paths']>) => void;
  /** Upgrade the local pi CLI (`pi update self`) then re-discover — syncs the version desktop runs. */
  upgradeLocalPi: () => Promise<void>;
  disconnectRun: (key: string) => void;
  notify: (n: Omit<NotificationItem, 'id' | 'read'>) => void;
}

export type PiReplicaStore = PiReplicaState & PiReplicaActions;

let started = false;
let loadSeq = 0;
let marketSearchTimer: ReturnType<typeof setTimeout> | undefined;

function currentRun(state: PiReplicaState): PiRun | undefined {
  return state.runs.find((r) => r.key === state.selectedKey);
}

let navPlayback = false;

export const usePiStore = create<PiReplicaStore>((set, get) => {
  const pushNotice = (text: string) => set({ notice: text });
  const pushNotification = (n: Omit<NotificationItem, 'id' | 'read'>) => {
    const item: NotificationItem = { ...n, id: `nt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, read: false };
    set({ notifications: [item, ...get().notifications].slice(0, 20) });
  };
  const attempt = async (fn: () => Promise<unknown>): Promise<unknown> => {
    try {
      return await fn();
    } catch (e) {
      set({ error: String((e as Error).message ?? e) });
      return undefined;
    }
  };

  // 历史刷新合并：message_end（每条助手消息一个）与 agent_settled 会背靠背触发；
  // get_messages 要在 pi 里序列化整个会话（大会话 MB 级），风暴式调用会把 pi 与
  // 主进程同时拖住。400ms 内合并请求；在途期间的新请求留到下一次读取，
  // 既不并发刷大历史，也不把发送前的旧快照当作发送后的刷新结果。
  let historyDebounce: ReturnType<typeof setTimeout> | null = null;
  let historyInFlight = false;
  let historyWaiters: Array<(ok: boolean) => void> = [];
  // Publish history and acknowledgements atomically, avoiding duplicate user bubbles.
  const settlePendingPrompt = (value: import('../../shared/pi').PiHistory, key: string) => {
    const s = get();
    const sends = confirmSends(s.sends ?? [], value, key);
    set({ history: value, sends });
    if (sends.some(send => send.key === key && send.at === s.pendingPromptAt && send.confirmedId)) {
      set({ pendingPrompt: undefined, pendingPromptAt: undefined });
    }
    const steer = s.pendingSteer?.[key];
    if (steer && confirmSends([{ ...steer, id: `steer-${steer.at}`, key }], value, key)[0].confirmedId) {
      const rest = { ...s.pendingSteer };
      delete rest[key];
      set({ pendingSteer: rest });
    }
  };
  const doRefreshHistory = async (attempt = 0): Promise<boolean> => {
    const state = get();
    const api = typeof window !== 'undefined' ? window.localPi : undefined;
    const key = state.selectedKey;
    if (!api || !key) return false;
    const seq = ++loadSeq;
    try {
      const value = await api.history(key, state.leaf);
      if (seq !== loadSeq || get().selectedKey !== key) return false;
      settlePendingPrompt(value, key);
      if (historyReloadTimer) { clearTimeout(historyReloadTimer); historyReloadTimer = null; }
      return true;
    } catch {
      // 保留旧 history：一次 IPC 失败不该把整条对话从界面上清空。
      // 但 selectSession 场景没有“旧 history”（进入会话时已置 undefined）：
      // 大会话序列化慢或 pi 忙时首次加载失败，流会永久空白且无事件再触发刷新。
      // 自动重试直到成功（退避 1s→2s→4s→…封顶 8s；成功/切会话/已加载即停）。
      if (seq === loadSeq && get().selectedKey === key && get().history === undefined) {
        scheduleHistoryReload(key, attempt + 1);
      }
      return false;
    }
  };
  let historyReloadTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleHistoryReload = (key: string, attempt: number) => {
    if (historyReloadTimer) clearTimeout(historyReloadTimer);
    historyReloadTimer = setTimeout(() => {
      historyReloadTimer = null;
      void doRefreshHistory(attempt);
    }, Math.min(8000, 1000 * 2 ** Math.max(0, attempt - 1)));
  };
  // 切屏/切窗回来（focus / 可见性恢复）：后台期间的事件与 IPC 可能丢失，
  // ① 会话历史还空着（selectSession 后首次加载失败）→ 立即重试；
  // ② 本地 run 卡在 running/starting → 拉 pi 侧快照对齐（pi 已结束则置 idle + 刷历史），
  //    否则工作条会永续计时、活动组永远展开不可收（实测卡 16min+）。
  const reconcileOnFocus = () => {
    if (document.visibilityState !== 'visible') return;
    const state = get();
    const key = state.selectedKey;
    if (!key) return;
    if (state.history === undefined) void refreshHistory();
    const stuck = state.runs.find(r => r.key === key && ['running', 'starting', 'stopping'].includes(r.status) && !r.pending);
    if (stuck) {
      void (window.localPi?.runs?.() ?? Promise.resolve(null)).then((remote) => {
        if (!remote) return;
        const live = remote.find(r => r.key === key);
        if (live && ['running', 'starting', 'stopping'].includes(live.status)) return; // pi 侧真在跑
        const cur = get();
        const still = cur.runs.find(r => r.key === key && ['running', 'starting', 'stopping'].includes(r.status) && !r.pending);
        if (still) set({ runs: [...cur.runs.filter(r => r.key !== key), { ...still, status: 'idle' }] });
        if (cur.sentAt?.key === key) set({ sentAt: undefined });
        void refreshHistory();
      }).catch(() => undefined);
    }
  };
  const scheduleHistoryRefresh = () => {
    if (historyDebounce || historyInFlight || !historyWaiters.length) return;
    historyDebounce = setTimeout(() => {
      historyDebounce = null;
      historyInFlight = true;
      const waiters = historyWaiters;
      historyWaiters = [];
      void doRefreshHistory().then(ok => waiters.forEach(done => done(ok))).finally(() => {
        historyInFlight = false;
        scheduleHistoryRefresh();
      });
    }, 400);
  };
  const refreshHistory = (): Promise<boolean> => new Promise(resolve => {
    historyWaiters.push(resolve);
    scheduleHistoryRefresh();
  });

  const reloadSessions = async () => {
    const api = window.localPi;
    if (!api) return;
    try {
      const [sessions, archivedKeys] = await Promise.all([api.sessions(), api.archivedSessions()]);
      set({ sessions, archivedKeys });
    } catch (e) {
      set({ error: String((e as Error).message ?? e) });
    }
  };

  // Streaming deltas (message_update / tool_execution_update) arrive many
  // times per second; writing each one to the store re-renders the whole
  // message list and starves typing. Buffer them and flush on a short timer.
  const pendingLive = new Map<string, Record<string, Record<string, unknown>>>();
  const pendingTools = new Map<string, ToolProgress[]>();
  // RPC message_update 的 delta 累积态（按会话）：text/thinking/toolCall 块逐段拼装，
  // message_end 后保留按消息的身份/快照以接收迟到事件，只清当前匿名流指针。
  // A stream belongs to the message that started it, not whichever agent_start
  // most recently arrived. Keep its identity through done -> message_end.
  type Stream = { id: string; owner?: string; message: Record<string, unknown>; blocks: Record<string, unknown>[] };
  const streams = new Map<string, Map<string, Stream>>();
  const activeStreams = new Map<string, Stream>();
  // 每个会话的工具事件水位：agent_settled 的异步 refreshHistory 期间若新一轮
  // （如排队 follow-up）已开始产生工具事件，水位会变化，据此避免误清新一轮工具。
  const toolEventEpoch = new Map<string, number>();
  let streamFlushTimer: ReturnType<typeof setTimeout> | null = null;
  const flushStreamEvents = () => {
    streamFlushTimer = null;
    if (!pendingLive.size && !pendingTools.size) return;
    const state = get();
    let live = state.live;
    if (pendingLive.size) {
      live = { ...live };
      for (const [key, messages] of pendingLive) live[key] = { ...live[key], ...messages };
      pendingLive.clear();
    }
    let toolProgress = state.toolProgress;
    if (pendingTools.size) {
      toolProgress = { ...toolProgress };
      for (const [key, list] of pendingTools) toolProgress[key] = list;
      pendingTools.clear();
    }
    set({ live, toolProgress });
  };
  const scheduleStreamFlush = (immediate = false) => {
    if (immediate) { if (streamFlushTimer) { clearTimeout(streamFlushTimer); } flushStreamEvents(); return; }
    if (streamFlushTimer) return;
    streamFlushTimer = setTimeout(flushStreamEvents, 150);
  };

  const activeTurn = new Map<string, string>();
  const handleRpcEvent = (key: string, raw: Record<string, unknown>) => {
    const type = String(raw.type ?? '');
    const state = get();
    const activeSend = state.sends?.find(s => s.key === key && s.id === activeTurn.get(key));
    const lastUser = state.selectedKey === key ? state.history?.branch.filter(e => e.message?.role === 'user').at(-1) : undefined;
    const currentOwner = activeSend && !activeSend.confirmedId ? activeSend.id
      : lastUser?.id ? state.sends?.find(s => s.key === key && s.confirmedId === lastUser.id)?.id ?? `history:${lastUser.id}`
      : activeSend?.id;
    if (type === 'agent_start') {
      const send = state.sends?.filter(s => s.key === key).at(-1);
      if (send) activeTurn.set(key, send.id);
      // 用户消息在 prompt 时即已落盘：agent_start 立刻刷历史，让真实用户气泡马上
      // 替换乐观气泡，而不是等到第一条助手消息 message_end（模型首 token 可能要几十秒）。
      void refreshHistory();
    }
    if (['tool_execution_start', 'tool_execution_update', 'tool_execution_end'].includes(type)) {
      toolEventEpoch.set(key, (toolEventEpoch.get(key) ?? 0) + 1);
      const toolCallId = String(raw.toolCallId ?? '');
      const previous=(pendingTools.get(key)??state.toolProgress[key]??[]).find(t=>t.toolCallId===toolCallId);
      const list = (pendingTools.get(key) ?? state.toolProgress[key] ?? []).filter((t) => t.toolCallId !== toolCallId);
      const text = clean(
        contentText((raw.partialResult as any)?.content ?? (raw.result as any)?.content) || (type === 'tool_execution_start' ? JSON.stringify(raw.args ?? {}) : '执行完成'),
      );
      list.push({
        turnId: previous ? previous.turnId : currentOwner,
        messageId: previous ? previous.messageId : activeStreams.get(key)?.owner === currentOwner ? activeStreams.get(key)?.id : undefined,
        toolCallId,
        details:(raw.partialResult as any)?.details??(raw.result as any)?.details??previous?.details,
        detailsFinal:type==='tool_execution_end'&&!!(raw.result as any)?.details,
        phase:type==='tool_execution_end'?'result':'progress',
        name: clean(raw.toolName ?? '工具'),
        text,
        status: type === 'tool_execution_end' ? (raw.isError || (raw.result as any)?.isError ? 'error' : 'done') : 'running',
        // 记录参数（tool_execution_start 带 raw.args）供运行中的工具出文件链接 + 行数统计。
        argumentsText: raw.args !== undefined ? JSON.stringify(raw.args ?? {}) : previous?.argumentsText,
      });
      pendingTools.set(key, list);
      scheduleStreamFlush(type === 'tool_execution_end');
      return;
    }
    if (type === 'agent_settled') {
      scheduleStreamFlush(true);
      // 计时条兜底：agent_settled 是轮次结束的权威信号。run 状态事件若在传输中丢失
      // （事件重排、pi 中途重启重连），renderer 的 run 会卡在 running、或 sentAt 残留
      // 使 idle 下 sending 恒真——工作条按发送时刻永续计时（实测 1h+ 不停表）。
      // 这里把两者拉直；正常流里 running 事件早已清过，此处是幂等兜底。
      if (get().sentAt?.key === key) set({ sentAt: undefined });
      const stuck = get().runs.find(r => r.key === key && ['running', 'starting', 'stopping'].includes(r.status) && !r.pending);
      if (stuck) set({ runs: [...get().runs.filter(r => r.key !== key), { ...stuck, status: 'idle' }] });
      // 一轮落地：重试状态随轮结束清掉（auto_retry_end 通常已先到，这里是兜底，防 pi 某些路径不发 end）
      const prevRetry = get().retrying[key];
      if (prevRetry) set({ retrying: { ...get().retrying, [key]: null } });
      // 先确认该轮已成功落库再清实时工具步骤，否则历史刷新失败时刚跑完的过程信息会凭空消失；
      // 且刷新期间若下一轮工具事件已到（水位变化），不能把它们一并清掉。
      const epoch = toolEventEpoch.get(key) ?? 0;
      void refreshHistory().then((ok) => {
        // Only retire results actually present in this session's history; a successful
        // but stale refresh is not proof that every real tool step was persisted.
        if (ok && get().selectedKey === key && (toolEventEpoch.get(key) ?? 0) === epoch) {
          const saved = new Set(get().history?.branch.filter(e => e.message?.role === 'toolResult').map(e => e.message?.toolCallId));
          set({ toolProgress: { ...get().toolProgress, [key]: (get().toolProgress[key] ?? []).filter(t => !saved.has(t.toolCallId)) } });
        }
        // 「立即」气泡兑底：轮次已结束，该条既没落盘也不在队列里 = 已被丢弃，撤气泡。
        const s = get();
        const steer = s.pendingSteer?.[key];
        if (steer) {
          const stillStaged = s.runs.find(r => r.key === key)?.queue?.some(q => q.behavior === 'steer' && q.text === steer.text);
          if (!stillStaged) {
            const rest = { ...s.pendingSteer };
            delete rest[key];
            set({ pendingSteer: rest });
          }
        }
      });
      void reloadSessions();
      return;
    }
    if (type === 'message_start' && (raw.message as any)?.role === 'assistant') {
      const message = raw.message as Record<string, unknown>;
      const id = String(message.timestamp ?? message.id ?? `stream:${crypto.randomUUID()}`);
      const previous = pendingLive.get(key)?.[id] ?? state.live[key]?.[id];
      const owner = previous ? previous._turnId as string | undefined : currentOwner;
      const stream: Stream = { id, owner, message: structuredClone(message), blocks: Array.isArray(message.content) ? structuredClone(message.content) : [] };
      const session = streams.get(key) ?? new Map<string, Stream>();
      session.set(id, stream);
      streams.set(key, session);
      activeStreams.set(key, stream);
      const bucket = pendingLive.get(key) ?? {};
      bucket[id] = { ...structuredClone(message), _turnId: owner };
      pendingLive.set(key, bucket);
      scheduleStreamFlush();
      return;
    }
    if (['message_update', 'message_end'].includes(type)) {
      // pi ≥0.87 的 RPC message_update 只带增量（assistantMessageEvent，partial 快照被
      // toJsonEvent 剥掉），不处理 delta 的话流式文本只能等 message_end 落盘才出现——
      // CLI 逐 token 直写终端而 GUI 干等整条消息，正是「CLI 快 GUI 慢」的主因。
      const delta = (raw as { assistantMessageEvent?: Record<string, unknown> }).assistantMessageEvent;
      if (type === 'message_update' && delta && typeof delta.type === 'string') {
        const message = raw.message as Record<string, unknown> | undefined;
        const identity = message?.timestamp ?? message?.id;
        const session = streams.get(key) ?? new Map<string, Stream>();
        let stream = identity !== undefined ? session.get(String(identity)) : activeStreams.get(key);
        if (!stream || (identity === undefined && delta.type === 'start' && stream.blocks.length)) {
          const id = String(identity ?? `stream:${crypto.randomUUID()}`);
          const previous = pendingLive.get(key)?.[id] ?? state.live[key]?.[id];
          stream = { id, owner: previous ? previous._turnId as string | undefined : currentOwner, message: structuredClone(previous ?? message ?? { role: 'assistant' }), blocks: Array.isArray(previous?.content) ? structuredClone(previous.content) : [] };
          session.set(id, stream);
          streams.set(key, session);
          // An identified late update is not a new message_start.
          if (identity === undefined || !activeStreams.has(key)) activeStreams.set(key, stream);
        }
        if (message) stream.message = { ...stream.message, ...structuredClone(message) };
        // RPC versions may include both the full post-delta message and delta.
        // The snapshot is authoritative; applying the delta again duplicates it.
        const snapshot = Array.isArray(message?.content) || typeof message?.content === 'string';
        if (snapshot) stream.blocks = Array.isArray(message!.content) ? structuredClone(message!.content) : [{ type: 'text', text: message!.content }];
        const blocks = stream.blocks;
        const finished = snapshot ? false : applyAssistantStreamDelta(blocks, delta);
        if (!finished) {
          const bucket = pendingLive.get(key) ?? {};
          // 快照拷贝：flush 与下一个 delta 之间不让渲染层看到半写的块。
          bucket[stream.id] = { ...stream.message, role: 'assistant', _turnId: stream.owner, content: structuredClone(blocks) };
          pendingLive.set(key, bucket);
          scheduleStreamFlush();
          if (get().retrying[key]) set({ retrying: { ...get().retrying, [key]: null } });
        }
        return;
      }
      const message = raw.message as Record<string, unknown> | undefined;
      if (message && message.role === 'assistant') {
        const identity = message.timestamp ?? message.id;
        const active = activeStreams.get(key);
        const stream = identity !== undefined ? streams.get(key)?.get(String(identity)) ?? (active?.id.startsWith('stream:') ? active : undefined) : active;
        const id = String(identity ?? stream?.id ?? 'stream');
        const bucket = pendingLive.get(key) ?? {};
        const previous = bucket[id] ?? state.live[key]?.[id];
        const belongsToStream = stream && (stream.id === id || (!previous && stream.id.startsWith('stream:')));
        const owner = previous ? previous._turnId : belongsToStream ? stream.owner : currentOwner;
        bucket[id] = { ...stream?.message, ...previous, ...structuredClone(message), _turnId: owner };
        // Replace only this message's anonymous delta snapshot. A delayed old
        // message_end must never delete a newer message's stream.
        if (belongsToStream) {
          if (stream.id !== id) {
            const tools = pendingTools.get(key) ?? get().toolProgress[key];
            if (tools) pendingTools.set(key, tools.map(t => t.messageId === stream.id ? { ...t, messageId: id } : t));
            delete bucket[stream.id];
            const remaining = { ...get().live[key] };
            delete remaining[stream.id];
            set({ live: { ...get().live, [key]: remaining } });
          }
          stream.message = bucket[id];
          stream.blocks = Array.isArray(message.content) ? structuredClone(message.content) : typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : stream.blocks;
          if (stream.id !== id) {
            streams.get(key)?.delete(stream.id);
            stream.id = id;
            streams.get(key)?.set(id, stream);
          }
          // Retain per-message identity for late updates, but no longer use a
          // completed message as the anonymous active stream.
          if (type === 'message_end' && activeStreams.get(key) === stream) activeStreams.delete(key);
        }
        pendingLive.set(key, bucket);
        scheduleStreamFlush(type === 'message_end');
        // 重试后模型开始流式输出 → 重试已生效，清掉残留的「正在重试」状态（auto_retry_end 兜底）
        if (get().retrying[key]) set({ retrying: { ...get().retrying, [key]: null } });
      }
      if (type === 'message_end') {
        void refreshHistory();
      }
      return;
    }
    if (type === 'auto_retry_start') {
      // 模型超时/错误后 pi 自动重试：把状态挂到 working bar，避免「转圈但不知在做啥」
      set({ retrying: { ...get().retrying, [key]: { attempt: Number(raw.attempt ?? 1), max: Number(raw.maxAttempts ?? 0) } } });
      const attempt = Number(raw.attempt ?? 1);
      const max = Number(raw.maxAttempts ?? 0);
      pushNotification({ kind: 'info', title: 'pi 正在自动重试', body: `第 ${attempt}${max ? `/${max}` : ''} 次重试：${clean(raw.errorMessage) || '当前任务尚未完成。'}`, time: '刚刚' });
      return;
    }
    if (type === 'auto_retry_end') {
      if (get().retrying[key]) set({ retrying: { ...get().retrying, [key]: null } });
      return;
    }
    if (type === 'compaction_start') {
      pushNotification({ kind: 'info', title: 'pi 正在压缩上下文', time: '刚刚' });
      return;
    }
    if (type === 'extension_error') {
      const message = `扩展错误：${clean(raw.error ?? raw.message)}`;
      set({ error: message });
      pushNotification({ kind: 'error', title: message, time: '刚刚' });
    }
  };

  // 导航回放期间置位：订阅器不再把回放产生的视图/会话变化当作新条目入栈，
  // 否则会截断前进分支（浏览器式语义的关键）。
  const applyNavEntry = (result: { history: NavHistory; entry: NavEntry }, setNow: typeof set, getNow: typeof get, refresh: () => void) => {
    navPlayback = true;
    try {
      const entry = result.entry;
      if (entry.view === 'chat' && entry.key) {
        setNow({ selectedKey: entry.key, leaf: undefined, history: undefined, review: undefined, view: 'chat', draftText: '', contextItems: [], recoveredSubagents: [], subagentDismissed: getNow().desktopPreferences?.subagentDismissed?.[entry.key] ?? [], navHistory: result.history });
        refresh();
      } else if (entry.view === 'chat') {
        setNow({ view: 'home', selectedKey: null, history: undefined, leaf: undefined, review: undefined, navHistory: result.history });
      } else {
        setNow({ view: entry.view, notificationsOpen: false, navHistory: result.history });
      }
    } finally {
      navPlayback = false;
    }
  };

  return {
    ready: false,
    env: undefined,
    sessions: [],
    archivedKeys: [],
    runs: [],
    resources: [],
    piPackages: [],
    market: [],
    marketQuery: '',
    marketLoading: false,
    covers: {},
    catalog: undefined,
    catalogLoading: false,

    selectedKey: null,
    history: undefined,
    leaf: undefined,
    titles: {},
    renames: {},

    view: 'home',
    navHistory: pushNavEntry(createNavHistory(), { view: 'home' }),
    settingsPage: 'general',
    sidebarCollapsed: false,
    expandedProjects: [],

    lang: 'zh',
    theme: 'light',
    fontScale: 100,
    font: 'System default',
    behavior: 'followUp',
    draftText: '',
    contextItems: [],
    pendingPrompt: undefined,
    pendingPromptAt: undefined,

    connecting: false,
    addingProject: false,
    changingAccessMode: false,
    recoveredSubagents: [],
    paths: { runtime:'auto', executable: '', agentDir: '', sessionDirs: '' },

    workbenchOpen: false,
    workbenchTab: 'review',
    review: undefined,
    reviewLoading: false,

    searchOpen: false,
    searchQuery: '',
    notificationsOpen: false,
    notifications: [],
    notice: undefined,
    error: undefined,

    dialogs: [],
    live: {},
    toolProgress: {},
    retrying: {},
    widgets: {},

    resetCounter: 0,

    // -- actions ---------------------------------------------------------

    init: () => {
      const api = window.localPi;
      if (!api || started) return;
      started = true;
      window.addEventListener?.('focus', reconcileOnFocus);
      (typeof document !== 'undefined' ? document.addEventListener?.('visibilitychange', reconcileOnFocus) : undefined);
      void api.settingsSnapshot().then(data => set({ desktopPreferences: data.preferences, behavior: data.preferences.behavior, renames: data.preferences.sessionRenames ?? {}, aiSettings: data.ai })).catch(e => set({ error: String(e) }));
      const prefs = loadPrefs();
      set({ lang: prefs.lang, theme: prefs.theme, fontScale: prefs.fontScale });
      const alive = () => started;
      void Promise.all([api.environment(), api.sessions(), api.runs(), api.archivedSessions()])
        .then(([environment, sessions, runs, archivedKeys]) => {
          if (!alive()) return;
          set({
            ready: true,
            env: environment,
            sessions,
            archivedKeys,
            runs,
            paths: {
              runtime:environment.requestedRuntime ?? 'auto',
              executable: environment.customExecutable ?? '',
              agentDir: environment.agentDir,
              sessionDirs: environment.sessionDirs.join('\n'),
            },
            expandedProjects: sessions[0] ? [sessions[0].cwd] : [],
          });
          // Open a ready-to-use Desktop composer; history remains in the sidebar.
          get().loadCatalog();
          // 扩展页依赖这份列表；启动即扫描，避免首次进入是空的。
          get().scanResources();
          get().loadPackages();
        })
        .catch((e) => set({ ready: true, error: String((e as Error).message ?? e) }));

      api.onEvent((event: PiEvent) => {
        if (!alive()) return;
        const state = get();
        switch (event.type) {
          case 'sessions-changed':
            void reloadSessions();
            void refreshHistory();
            break;
          case 'resources-changed':
            get().scanResources();
            get().loadPackages();
            break;
          case 'run': {
            // pi 的 queue_update 要等当前轮次告一段落才来，期间流式 run 事件会整包覆盖
            // store、把乐观入队的追问“抹掉”近一分钟。后端视图未带回队列时保留仍处于
            // pendingSync 的乐观项；任何权威队列（queue_update/队列管理）都用无标记项
            // 整体替换，自然解除保留。
            const prevRun = state.runs.find((r) => r.key === event.run.key);
            const preserved = (prevRun?.queue ?? []).filter((q) => q.pendingSync);
            const mergedRun = preserved.length && !event.run.queue?.length && ['running', 'starting'].includes(event.run.status)
              ? { ...event.run, queue: preserved, pending: Math.max(event.run.pending ?? 0, preserved.length) }
              : event.run;
            set({ runs: [...state.runs.filter((r) => r.key !== event.run.key), mergedRun] });
            // 任务真正开始/停止/出错后，发送空窗的即时计时完成使命
            if (['running', 'stopping', 'error'].includes(event.run.status)) set({ sentAt: undefined });
            if (event.run.error) set({ error: event.run.error });
            break; }
          case 'closed':
            set({
              runs: state.runs.filter((r) => !(r.key === event.key && r.generation === event.generation)),
              dialogs: state.dialogs.filter((d) => d.generation !== event.generation),
              // pi 退出后不会有任何 run 事件再来清发送计时，残留会让重连后的 idle 会话恒显工作条。
              ...(state.sentAt?.key === event.key ? { sentAt: undefined } : {}),
            });
            // 会话已关闭：乐观 steer 气泡不再有落盘归宿，直接撤掉。
            if (state.pendingSteer?.[event.key]) {
              const rest = { ...state.pendingSteer };
              delete rest[event.key];
              set({ pendingSteer: rest });
            }
            // pi 退出（含崩溃）前已完成的内容都已落盘——立即从会话文件补齐，
            // 避免 UI 停留在最后一帧 live 状态、看起来像卡死。
            void refreshHistory();
            // 尝试从磁盘恢复未完成的子代理进度（扩展在 onUpdate 时持久化）。
            void window.localPi!.recoverSubagents(event.key).then((recovered: unknown) => {
              if (Array.isArray(recovered) && recovered.length) set({ recoveredSubagents: recovered as PiReplicaState['recoveredSubagents'] });
            }).catch(() => undefined);
            break;
          case 'ui': {
            const r = event.request;
            if (['select', 'confirm', 'input', 'editor'].includes(r.method)) {
              set({
                dialogs: [
                  ...state.dialogs.filter((d) => !(d.key === event.key && d.generation === event.generation && d.request.id === r.id)),
                  { key: event.key, generation: event.generation, request: r },
                ],
              });
            } else if (r.method === 'notify') {
              pushNotification({ kind: 'info', title: clean(r.message) || 'pi 通知', time: '刚刚' });
            } else if (r.method === 'set_editor_text') {
              if (state.selectedKey === event.key) set({ draftText: String(r.text ?? '') });
            } else if (r.method === 'setTitle') {
              set({ titles: { ...state.titles, [event.key]: clean(r.title) } });
            } else if (r.method === 'setStatus' || r.method === 'setWidget') {
              const id = String((r as Record<string, unknown>).statusKey ?? (r as Record<string, unknown>).widgetKey ?? Date.now());
              const value =
                r.method === 'setStatus'
                  ? clean((r as Record<string, unknown>).statusText)
                  : Array.isArray((r as unknown as { widgetLines: unknown[] }).widgetLines)
                    ? (r as unknown as { widgetLines: unknown[] }).widgetLines.map(clean).join('\n')
                    : '';
              const forRun = { ...(state.widgets[event.key] ?? {}) };
              if (value) forRun[id] = value;
              else delete forRun[id];
              set({ widgets: { ...state.widgets, [event.key]: forRun } });
            }
            break;
          }
          case 'rpc':
            if (event.event.type === 'ui-expired') {
              set({dialogs: state.dialogs.filter(d => !(d.key === event.key && d.generation === event.generation && d.request.id === event.event.id))});
            }
            if (state.runs.some(r => r.key === event.key && r.generation === event.generation)) handleRpcEvent(event.key, event.event);
            break;
        }
      });
    },

    navigate: (view) => { closeTransientPopovers(); set({ view, notificationsOpen: false }); },
    navBack: () => {
      const result = navHistoryBack(get().navHistory);
      if (!result) return;
      applyNavEntry(result, set, get, () => void refreshHistory());
    },
    navForward: () => {
      const result = navHistoryForward(get().navHistory);
      if (!result) return;
      applyNavEntry(result, set, get, () => void refreshHistory());
    },
    runAutomationNow: (task) => {
      const startedAt = Date.now();
      // 乐观跳转：点击瞬间就看到指令飞进对话（气泡带发送动画），pi 会话建立后无缝切过去。
      set({ view: 'chat', selectedKey: null, history: undefined, leaf: undefined, review: undefined, automationLaunch: { name: task.name, prompt: task.previewPrompt, startedAt } });
      void (async () => {
        try {
          const run = await window.localPi!.automationRunTask(task.id);
          // automation-changed 随 run 变化推送；sessionKey 就绪即切入真实会话，计时从点击时刻起跳。
          const off = window.localPi!.onAutomationChanged(() => {
            void window.localPi!.automationSnapshot().then(snap => {
              const key = snap.runs.find(r => r.id === run.id)?.sessionKey;
              if (!key) return;
              off();
              set(s => ({ automationLaunch: s.automationLaunch ? { ...s.automationLaunch, sessionKey: key } : s.automationLaunch, sentAt: { key, at: startedAt } }));
              get().selectSession(key);
            }).catch(() => undefined);
          });
          const timer = setTimeout(off, 120_000) as { unref?: () => void };
          timer.unref?.();
        } catch (e) {
          set({ error: String((e as Error).message || e), automationLaunch: undefined, view: 'automations' });
        }
      })();
    },
    openSettings: (page) => { closeTransientPopovers(); set({ view: 'settings', settingsPage: page, notificationsOpen: false }); },
    backToApp: () => { closeTransientPopovers(); set({ view: get().selectedKey ? 'chat' : 'home' }); },
    toggleSidebar: () => set({ sidebarCollapsed: !get().sidebarCollapsed }),
    toggleProject: (cwd) =>
      set({
        expandedProjects: get().expandedProjects.includes(cwd)
          ? get().expandedProjects.filter((p) => p !== cwd)
          : [...get().expandedProjects, cwd],
      }),

    setSessionArchived: async (key, archived) => {
      const result = await attempt(()=>window.localPi!.setSessionArchived(key,archived)) as string[] | undefined;
      if(!result) return false;
      const session = get().sessions.find(s=>s.key===key);
      set({archivedKeys: result, ...(!archived && session ? {expandedProjects:[...new Set([...get().expandedProjects,session.cwd])]} : {})});
      if(archived && get().selectedKey===key) {
        const {draftText,contextItems}=get();get().startNewSession();set({draftText,contextItems});
      }
      return true;
    },
    deleteArchivedSession: async (key) => {
      const result = await attempt(()=>window.localPi!.deleteArchivedSession(key)) as string[] | undefined;
      if(!result) return false;
      set({archivedKeys: result, sessions: get().sessions.filter(s=>s.key!==key)});
      return true;
    },
    selectSession: (key) => {
      set((s) => ({ selectedKey: key, leaf: undefined, history: undefined, review: undefined, view: 'chat', draftText: '', contextItems: [], recoveredSubagents: [], subagentDismissed: s.desktopPreferences?.subagentDismissed?.[key] ?? [] }));
      void refreshHistory();
    },
    dismissSubagent: (callId) => {
      const s = get();
      const key = s.selectedKey;
      if (!key) return;
      const dismissed = [...new Set([...(s.subagentDismissed ?? []), callId])];
      set({ subagentDismissed: dismissed });
      const prefs = s.desktopPreferences;
      if (prefs) {
        const map = { ...(prefs.subagentDismissed ?? {}), [key]: dismissed };
        set({ desktopPreferences: { ...prefs, subagentDismissed: map } });
        void window.localPi?.saveDesktopSettings({ subagentDismissed: map }).catch(() => undefined);
      }
    },
    dismissFinishedSubagents: (callIds) => {
      const s = get();
      const key = s.selectedKey;
      if (!key || !callIds.length) return;
      const dismissed = [...new Set([...(s.subagentDismissed ?? []), ...callIds])];
      set({ subagentDismissed: dismissed });
      const prefs = s.desktopPreferences;
      if (prefs) {
        const map = { ...(prefs.subagentDismissed ?? {}), [key]: dismissed };
        set({ desktopPreferences: { ...prefs, subagentDismissed: map } });
        void window.localPi?.saveDesktopSettings({ subagentDismissed: map }).catch(() => undefined);
      }
    },
    setDraftText: (draftText) => set({ draftText }),

    resendEdited: async (entryId, text) => {
      const s = get();
      const key = s.selectedKey;
      if (!key || !text.trim()) return;
      try {
        await window.localPi!.forkMessage(key, s.sends?.find(send => send.id === entryId)?.confirmedId ?? entryId);
      } catch (e) {
        set({ error: String((e as Error).message || e) });
        return;
      }
      // 截断已生效：先刷新历史（旧轮从视图消失），再走普通发送（乐观气泡复用同一条链路）。
      await refreshHistory();
      get().send(text.trim());
    },

    send: (text) => {
      const state = get();
      if ((!text.trim() && !state.contextItems.length) || state.connecting || state.changingAccessMode) return;
      // 内置 /compact：TUI 专用命令，RPC prompt 不会解析（会被当普通消息发给模型），
      // 这里拦截并路由到 pi RPC 的专用 compact 命令。
      const trimmedCommand = text.trim();
      if (trimmedCommand === '/compact' || trimmedCommand.startsWith('/compact ')) {
        const run = currentRun(state);
        if (!run) { set({ error: '没有运行中的任务；先发起对话后再压缩上下文。' }); return; }
        if (run.status !== 'idle') { set({ error: '任务运行中，请等空闲后再压缩上下文。' }); return; }
        const customInstructions = trimmedCommand.startsWith('/compact ') ? trimmedCommand.slice('/compact '.length).trim() || undefined : undefined;
        set({ draftText: '' });
        void window.localPi!.compact(run.key, customInstructions)
          .then((result) => {
            const before = (result as { tokensBefore?: number } | null)?.tokensBefore;
            pushNotification({ kind: 'success', title: before ? `上下文已压缩 · 压缩前约 ${before} tokens` : '上下文已压缩', time: '刚刚' });
            if (get().selectedKey === run.key) void refreshHistory();
          })
          .catch((error) => set({ error: String((error as Error).message ?? error) }));
        return;
      }
      const existing = currentRun(state);
      const sourceKey = existing ? undefined : state.selectedKey ?? undefined;
      const behavior = state.behavior;
      // One in-flight idle send per session; running follow-ups retain queue semantics.
      if (state.sends?.some(s => s.key === state.selectedKey && !s.confirmedId) && existing?.status === 'idle') return;
      let message: string;
      try { message = contextPrompt(text.trim() || '请查看所附文件。', state.contextItems); }
      catch (error) { set({ error: String((error as Error).message), draftText: text }); return; }
      const images = state.contextItems.flatMap(item => item.image ? [item.image] : []);
      const queued = existing && ['running', 'starting', 'stopping'].includes(existing.status);
      scheduleStreamFlush(true);
      const send: OptimisticSend = { id: `send-${crypto.randomUUID()}`, key: state.selectedKey, at: Date.now(), text: message, images, baseline: (state.history?.branch ?? []).flatMap(e => e.id ? [e.id] : []) };
      set({ connecting: !existing, sends: queued ? state.sends : [...(state.sends ?? []), send], pendingPrompt: queued ? undefined : message, pendingPromptAt: send.at, draftText: '', contextItems: [] });
      // 草稿首发立即切到 chat 视图：connect 空窗（pi 启动加载扩展可达 10s+）里 working bar、
      // 待发气泡、停止按钮都只存在于 ChatView——停在 home 的话用户只看到输入被清空，毫无反馈。
      if (!existing && get().view !== 'chat') set({ view: 'chat' });
      let targetKey = state.selectedKey;
      let queuedItem: NonNullable<PiRun['queue']>[number] | undefined;
      void (async () => {
        try {
          let run = existing;
          if (!run) {
            if (!get().env?.supported) throw new Error('pi 内核不可用，请在设置中检查 pi 安装路径。');
            const cwd = sourceKey ? undefined : state.draftCwd || await window.localPi!.pickDirectory();
            if (!sourceKey && !cwd) {
              set({ sends: get().sends?.filter(s => s.id !== send.id), pendingPrompt: undefined, pendingPromptAt: undefined });
              if (get().selectedKey === state.selectedKey && !get().draftText && !get().contextItems.length) set({ draftText: text, contextItems: state.contextItems });
              return;
            }
            const rememberedMode = state.desktopPreferences?.sessionAccessModes?.[state.selectedKey ?? ''];
          run = await window.localPi!.connect({ sourceKey, cwd: cwd || undefined, trustProject: false, permission: rememberedMode ?? state.draftAccessMode ?? state.desktopPreferences?.permission ?? 'ask', ...(state.previousExecutionMode ? { executionMode: state.previousExecutionMode } : {}) });
            targetKey = run.key;
            set({ runs: [...get().runs.filter(r => r.key !== run!.key), run], sends: get().sends?.map(s => s.id === send.id ? { ...s, key: run!.key } : s) });
            // Do not pull the user back if they navigated elsewhere during startup.
            if (get().selectedKey === state.selectedKey) get().selectSession(run.key);
            if (state.draftModelId) { const slash = state.draftModelId.indexOf('/'); await window.localPi!.model(run.key, state.draftModelId.slice(0,slash), state.draftModelId.slice(slash+1)); }
            const thinking = state.draftThinking ?? state.desktopPreferences?.defaultThinkingLevel;
            // pi 会将不支持的等级自动钳制到模型能力（非推理模型为 off），因此始终下发，避免代理模型漏报 max 时固化值失效。
            if (thinking && thinking !== 'off') await window.localPi!.thinking(run.key, thinking);
          }
          // Show the queued prompt immediately; pi's queue_update event will
          // replace this optimistic entry with the authoritative queue.
          if (queued) {
            queuedItem = { text: message, behavior, pendingSync: true, ...(images.length ? { images } : {}) };
            const optimistic = { ...run, queue: [...(run.queue ?? []), queuedItem], pending: (run.pending ?? 0) + 1 };
            // 运行中追问：队列胶囊就是即时反馈，乐观气泡立即退场避免双份。
            set({ runs: [...get().runs.filter(r => r.key !== run.key), optimistic], sends: get().sends?.filter(s => s.id !== send.id), pendingPrompt: undefined, pendingPromptAt: undefined });
          }
          // 记录发送时刻：prompt 应答后到 agent_start 之间的空窗，聊天界面照样立刻转圈计时
          set({ sentAt: { key: run.key, at: send.at } });
          await window.localPi!.prompt(run.key, message, behavior, ...(images.length ? [images] : []));
          if (get().selectedKey === run.key) void refreshHistory();
        } catch (error) {
          const current = get();
          const own = current.sends?.find(s => s.id === send.id);
          // Late rejection cannot erase another session's draft or an already confirmed send.
          set({ error: String((error as Error).message ?? error), sends: current.sends?.filter(s => s.id !== send.id || !!s.confirmedId),
            ...(current.selectedKey === (own?.key ?? targetKey) && !own?.confirmedId && !current.draftText && !current.contextItems.length ? { draftText: text, contextItems: state.contextItems } : {}),
            ...(current.pendingPromptAt === send.at ? { pendingPrompt: undefined, pendingPromptAt: undefined } : {}),
            ...(!own?.confirmedId && current.sentAt?.key === targetKey && current.sentAt.at === send.at ? { sentAt: undefined } : {}),
            ...(queuedItem ? { runs: current.runs.map(r => {
              if (r.key !== targetKey || !r.queue?.includes(queuedItem!)) return r;
              const queue = r.queue.filter(q => q !== queuedItem);
              return { ...r, queue, pending: queue.length };
            }) } : {}) });
        } finally {
          // pendingPrompt 不在这里清：prompt 应答 ≠ 用户消息已上屏。乐观气泡要撑到
          // 历史刷新带回真实用户条目（见 settlePendingPrompt），否则模型思考的几十秒里
          // 对话区只剩小转圈——正是「发出后 GUI 长时间无变化」的体感来源。
          set({ connecting: false });
        }
      })();
    },
    stop: () => {
      const state = get();
      const run = currentRun(state);
      if (!run) return;
      // 乐观反馈：立即置为 stopping，不等 IPC 往返，避免流式渲染繁工时按钮“按了没反应”。
      if (run.status === 'running') set({ runs: state.runs.map(r => (r.key === run.key ? { ...r, status: 'stopping' as const } : r)) });
      // 停止会丢弃待分发的 steer：乐观气泡随之撤掉（未执行项由下方恢复到输入框）。
      if (state.pendingSteer?.[run.key]) {
        const rest = { ...state.pendingSteer };
        delete rest[run.key];
        set({ pendingSteer: rest });
      }
      void attempt(async () => {
        const queue = (await window.localPi!.stop(run.key)) as { steering: string[]; followUp: string[] };
        const restored = [...queue.steering, ...queue.followUp].join('\n');
        if (restored) set({ draftText: restored });
        pushNotification({ kind: 'info', title: '已停止', body: '未执行的排队输入已恢复到输入框。', time: '刚刚' });
      });
    },
    queueEdit: (op) => {
      const state = get();
      const run = currentRun(state);
      if (!run || !run.queue?.length) return;
      // 「立即」把队列项附带图片带上（pi 的 queue_update 不回传图片）。
      const target = op.type === 'now' ? run.queue[op.index] : undefined;
      const fullOp = op.type === 'now' ? { ...op, images: target?.images } : op;
      // 乐观更新；权威状态以 pi 的 queue_update 为准，随后会覆盖这里。
      const items = run.queue.map((item, index) => (op.type === 'edit' && index === op.index ? { ...item, text: op.text } : { ...item }));
      const next = op.type === 'edit' ? items : items.filter((_, index) => index !== op.index);
      set({
        runs: state.runs.map((r) => (r.key === run.key ? { ...r, queue: next, pending: next.length } : r)),
        // 「立即」的即时反馈：消息立刻以乐观气泡进对话区，pi 什么时候真正截断分发
        // 不用前端等；真实用户条目落盘后由 settle 交换（queue_update 回流的 steer 项
        // 在渲染层按文本隐藏，避免气泡+胶囊双份）。
        pendingSteer: target ? { ...state.pendingSteer, [run.key]: { text: target.text, at: Date.now(), baseline: (state.history?.branch ?? []).flatMap(e => e.id ? [e.id] : []), images: target.images ?? [] } } : state.pendingSteer,
      });
      void (async () => {
        // queueEdit 的 IPC 成功也返回 void（undefined），不能用返回值区分成败，必须显式捕获。
        let failed: unknown;
        try { await window.localPi!.queueEdit(run.key, fullOp); } catch (error) { failed = error; }
        if (failed !== undefined) {
          set({ error: String((failed as Error).message ?? failed) });
          // 后端失败：按逆操作撤掉乐观更新（含「立即」的气泡），被移除/改动的项按点击前
          // 快照补回；之后新入队的项（如撤回失败后立刻重发）保留不冲掉。撤回已载入输入框的
          // 草稿/附件不收回（不丢草稿），用户可改后重发；pi 侧未动时 queue_update 也会校正。
          const rest = { ...get().pendingSteer };
          delete rest[run.key];
          set({
            ...(target ? { pendingSteer: rest } : {}),
            runs: get().runs.map(r => {
              if (r.key !== run.key) return r;
              const queue = [...(r.queue ?? [])];
              const snapshot = run.queue![op.index];
              if (op.type === 'edit') { if (op.index < queue.length) queue[op.index] = snapshot; }
              else if (!queue.includes(snapshot)) queue.splice(Math.min(op.index, queue.length), 0, snapshot);
              return { ...r, queue, pending: queue.length };
            }),
          });
          return;
        }
        if (op.type === 'now') get().notify({ kind: 'success', title: '已插入当前任务，将在当前步骤结束后生效', time: '刚刚' });
      })();
    },
    // ZCode 风格：点编辑把队列项（文字 + 图片附件）载回输入框，改完重发即按新内容重新排队。
    queueRecall: (index) => {
      const state = get();
      const run = currentRun(state);
      const item = run?.queue?.[index];
      if (!run || !item) return;
      const { head, items } = parseContextPrompt(item.text);
      const stamp = Date.now();
      const recalled: ContextItem[] = [
        ...items.map((it, i) => ({ id: `recall-doc-${stamp}-${i}`, name: it.name, path: it.path, kind: it.kind, text: it.text })),
        ...(item.images ?? []).map((image, i) => ({ id: `recall-img-${stamp}-${i}`, name: `图片 ${i + 1}`, path: '', kind: 'image' as const, text: '', image })),
      ];
      get().setDraftText(head);
      if (recalled.length) get().addContext(recalled);
      get().queueEdit({ type: 'remove', index });
      get().notify({ kind: 'info', title: state.lang === 'zh' ? '已载入输入框，可修改后重新发送' : 'Loaded into the input box; edit and re-send', time: '刚刚' });
    },
    pickModel: (combinedId) => {
      const state = get();
      const run = currentRun(state);
      if (!run) { set({draftModelId: combinedId}); return; }
      // 运行中也允许选择：后端挂起为待生效，在下一次模型调用边界统一切换。
      const slash = combinedId.indexOf('/');
      const provider = combinedId.slice(0,slash), id = combinedId.slice(slash+1);
      void attempt(() => window.localPi!.model(run.key, provider, id));
    },

    addContext: items => set(state => ({contextItems: [...new Map([...state.contextItems,...items].map(item=>[item.id,item])).values()]})),
    removeContext: id => set(state => ({contextItems:state.contextItems.filter(item=>item.id!==id)})),
    pickThinking: level => {
      const state = get();
      const run = currentRun(state);
      if (run) void attempt(() => window.localPi!.thinking(run.key, level));
      set({ draftThinking: level });
      // 固化到 Desktop 偏好：下次新会话/重启后仍生效。
      if (state.desktopPreferences) set({ desktopPreferences: { ...state.desktopPreferences, defaultThinkingLevel: level } });
      void window.localPi?.saveDesktopSettings({ defaultThinkingLevel: level }).catch(() => undefined);
    },
    reloadExtensions: () => {
      const state = get();
      const run = currentRun(state);
      if (!run) return;
      if (run.status !== 'idle') {
        pushNotice('会话仍在运行，空闲后才能重载扩展。');
        return;
      }
      void attempt(async () => {
        await window.localPi!.refresh(run.key);
        pushNotification({ kind: 'success', title: '扩展已重载', time: '刚刚' });
      });
    },
    disconnect: () => {
      const run = currentRun(get());
      if (!run) return;
      void attempt(() => window.localPi!.close(run.key));
    },
    renameSession: (key, name) => {
      const trimmed = name.trim();
      if (!trimmed || trimmed.length > 200) return;
      const renames = { ...get().renames, [key]: trimmed };
      set({ renames });
      void window.localPi!.saveDesktopSettings({ sessionRenames: renames }).catch(() => undefined);
    },
    startContinueCopy: (sourceKey) => get().selectSession(sourceKey),
    startNewSession: () => {
      const state = get();
      const cwd = currentRun(state)?.cwd ?? state.sessions.find(s => s.key === state.selectedKey)?.cwd ?? state.draftCwd ?? state.desktopPreferences?.projects[0]?.path;
      set({ selectedKey: null, history: undefined, leaf: undefined, review: undefined, view: 'home', draftText: '', contextItems: [], draftCwd: cwd, subagentDismissed: [] });
    },
    addProject: () => {
      if (get().addingProject) return;
      set({ addingProject: true });
      void attempt(async () => {
        const api = window.localPi!;
        const cwd = await api.pickDirectory();
        if (!cwd) return;
        await api.projectSave({ path: cwd, name: pathBase(cwd) });
        const { preferences } = await api.settingsSnapshot();
        const project = preferences.projects.find(p => p.path === cwd) ?? preferences.projects.at(-1);
        const projectPath = project?.path ?? cwd;
        get().startNewSession();
        set({ desktopPreferences: preferences, draftCwd: projectPath, expandedProjects: [...new Set([...get().expandedProjects, projectPath])] });
      }).finally(() => set({ addingProject: false }));
    },
    setAccessMode: async (mode) => {
      if (get().changingAccessMode || get().connecting) return false;
      // 固化到 Desktop 偏好：同一 session 重进后恢复上次选择。
      const remember = (key: string | undefined) => {
        if (!key) return;
        const prefs = get().desktopPreferences;
        const merged = { ...(prefs?.sessionAccessModes ?? {}), [key]: mode };
        const keys = Object.keys(merged);
        // 上限 500 条，超出时按插入序裁掉最旧的。
        const next = keys.length > 500 ? Object.fromEntries(keys.slice(keys.length - 500).map(k => [k, merged[k]])) : merged;
        if (prefs) set({ desktopPreferences: { ...prefs, sessionAccessModes: next } });
        void window.localPi?.saveDesktopSettings({ sessionAccessModes: next }).catch(() => undefined);
      };
      const run = currentRun(get());
      if (!run) {
        const previous = get().draftAccessMode ?? get().desktopPreferences?.permission ?? 'ask';
        set({ draftAccessMode: mode, previousExecutionMode: mode === 'plan' ? (previous === 'plan' ? get().previousExecutionMode ?? 'ask' : previous) : mode });
        remember(get().selectedKey ?? undefined);
        return true;
      }
      set({ changingAccessMode: true });
      const result = await attempt(() => window.localPi!.setAccessMode(run.key, mode)) as PiRun | undefined;
      if (result) { set({ runs: [...get().runs.filter(r => r.key !== result.key), result] }); remember(result.key); }
      set({ changingAccessMode: false });
      return !!result;
    },
    executePlan: (feedback) => {
      const state = get();
      const run = currentRun(state);
      const key = state.selectedKey;
      if (!run || run.accessMode !== 'plan' || run.status !== 'idle') return;
      void get().setAccessMode(run.executionMode ?? 'ask').then(ok => {
        if (ok && get().selectedKey === key) {
          // 附带反馈时将其作为审批注释发给 agent（ZCode plan_approval_feedback）
          get().send(feedback ? `计划已批准。${feedback}\n\n请按刚才的计划开始执行。` : '请按刚才的计划开始执行。');
        }
      });
    },
    declinePlan: (feedback) => {
      const state = get();
      const run = currentRun(state);
      if (!run || run.accessMode !== 'plan' || run.status !== 'idle') return;
      // 退回计划：把修改意见发给 agent，保持在计划模式内修订
      if (feedback) get().send(feedback);
    },
    chooseWorkspace: () => {
      void attempt(async () => {
        const cwd = await window.localPi!.pickDirectory();
        if (cwd) set({ draftCwd: cwd });
      });
    },
    setTheme: (theme) => {
      set({ theme });
      const { lang, fontScale, font } = get();
      savePrefs({ lang, theme, fontScale, font });
    },
    setLang: (lang) => {
      set({ lang });
      const { theme, fontScale, font } = get();
      savePrefs({ lang, theme, fontScale, font });
    },
    setFontScale: (fontScale) => {
      set({ fontScale });
      const { lang, theme, font } = get();
      savePrefs({ lang, theme, fontScale, font });
    },
    setFont: (font) => {
      set({ font });
      const { lang, theme, fontScale } = get();
      savePrefs({ lang, theme, fontScale, font });
    },

    toggleWorkbench: () => {
      const state = get();
      const open = !state.workbenchOpen;
      set({ workbenchOpen: open });
      if (open && state.workbenchTab === 'review') void get().selectWorkbenchTab(state.workbenchTab);
    },
    selectWorkbenchTab: (tab) => {
      set({ workbenchTab: tab, workbenchOpen: true });
      if (tab === 'review') {
        const state = get();
        const run = currentRun(state);
        const session = state.sessions.find((s) => s.key === state.selectedKey);
        const cwd = run?.cwd ?? session?.cwd;
        if (cwd && !state.reviewLoading) {
          set({ reviewLoading: true });
          void attempt(async () => {
            const review = (await window.localPi!.review(cwd)) as PiReview;
            set({ review, reviewLoading: false });
            return review;
          }).then((ok) => {
            if (ok === undefined) set({ reviewLoading: false });
          });
        }
      }
    },

    setSearchOpen: (searchOpen) => set({ searchOpen, searchQuery: searchOpen ? get().searchQuery : '' }),
    setSearchQuery: (searchQuery) => set({ searchQuery }),
    toggleNotifications: () => set({ notificationsOpen: !get().notificationsOpen }),
    markAllRead: () => set({ notifications: get().notifications.map((n) => ({ ...n, read: true })) }),
    dismissError: () => set({ error: undefined }),
    dismissNotice: () => set({ notice: undefined }),

    answerDialog: (response) => {
      const state = get();
      // 弹窗/内联卡按 request.id 定位；dialogs 现按会话分摊，不再假定一定是 dialogs[0]。
      const dialog = state.dialogs.find((d) => d.request.id === response.id);
      if (!dialog) return;
      set({ dialogs: state.dialogs.filter((d) => d !== dialog) });
      void attempt(() => window.localPi!.respond(dialog.key, dialog.generation, response));
    },

    scanResources: () => {
      const state = get();
      const run = currentRun(state);
      const session = state.sessions.find((s) => s.key === state.selectedKey);
      const cwd = run?.cwd ?? session?.cwd;
      void attempt(async () => {
        const resources = (await window.localPi!.resources(cwd)) as PiResource[];
        set({ resources });
        return resources;
      });
    },
    rescanAndReload: () => {
      get().scanResources();
      const run = currentRun(get());
      if (run && run.status === 'idle') {
        void attempt(async () => {
          await window.localPi!.refresh(run.key);
          pushNotification({ kind: 'success', title: '已在空闲会话中重载扩展', time: '刚刚' });
        });
      } else {
        pushNotification({ kind: 'info', title: '资源已重新扫描', body: '没有空闲的桌面会话可重载扩展。', time: '刚刚' });
      }
    },

    loadCatalog: () => {
      if (get().catalogLoading) return;
      set({ catalogLoading: true });
      void attempt(async () => {
        const catalog = await window.localPi!.modelCatalog();
        set({ catalog, catalogLoading: false });
        return catalog;
      }).then((ok) => {
        if (ok === undefined) set({ catalogLoading: false });
      });
    },

    loadPackages: () => {
      void attempt(async () => { set({ piPackages: await window.localPi!.packageList() }); });
    },
    searchMarketplace: (query) => {
      set({ marketQuery: query, marketLoading: true });
      clearTimeout(marketSearchTimer);
      marketSearchTimer = setTimeout(() => {
        void attempt(async () => {
          const market = await window.localPi!.packageSearch(query);
          set({ market, marketLoading: false });
          // 封面异步补齐：不阻塞搜索结果，失败静默（卡片回退首字母头像）。
          void window.localPi!.packageCovers(market.map((p) => p.name))
            .then((covers) => set({ covers: { ...get().covers, ...covers } }))
            .catch(() => undefined);
          return market;
        }).then((ok) => { if (ok === undefined) set({ marketLoading: false }); });
      }, 350);
    },
    installPackage: (spec) => {
      if (get().packageBusy) return;
      set({ packageBusy: spec });
      void attempt(async () => {
        const output = await window.localPi!.packageInstall(spec, 'install');
        pushNotification({ kind: 'success', title: `已安装 ${spec}`, body: output || undefined, time: '刚刚' });
        get().loadPackages(); get().scanResources();
      }).finally(() => set({ packageBusy: undefined }));
    },
    removePackage: (spec) => {
      if (get().packageBusy) return;
      set({ packageBusy: spec });
      void attempt(async () => {
        const output = await window.localPi!.packageInstall(spec, 'remove');
        pushNotification({ kind: 'info', title: `已移除 ${spec}`, body: output || undefined, time: '刚刚' });
        get().loadPackages(); get().scanResources();
      }).finally(() => set({ packageBusy: undefined }));
    },
    registerPackage: (spec) => {
      if (get().packageBusy) return;
      set({ packageBusy: spec });
      void attempt(async () => {
        await window.localPi!.packageRegister(spec);
        pushNotification({ kind: 'success', title: `已注册 ${spec}`, body: '新任务的运行时会在启动时加载。', time: '刚刚' });
        get().loadPackages(); get().scanResources();
      }).finally(() => set({ packageBusy: undefined }));
    },

    savePaths: () => {
      const state = get();
      if (state.runs.length > 0) {
        pushNotice('修改前请先断开所有桌面会话。');
        return;
      }
      void attempt(async () => {
        const environment = (await window.localPi!.configure({
          runtime:state.paths.runtime,
          executable: state.paths.runtime==='custom' ? state.paths.executable || undefined : undefined,
          agentDir: state.paths.agentDir || undefined,
          sessionDirs: state.paths.sessionDirs.split('\n').map((s) => s.trim()).filter(Boolean),
        })) as PiEnvironment;
        set({ env: environment });
        await reloadSessions();
        pushNotification({ kind: 'success', title: '连接配置已保存', time: '刚刚' });
        return environment;
      });
    },
    setPaths: (patch) => set({ paths: { ...get().paths, ...patch } }),
    upgradeLocalPi: async () => {
      const zh = get().lang === 'zh';
      set({ packageBusy: 'upgradeLocalPi' });
      try {
        const res = (await window.localPi!.upgradeLocalPi()) as { exitCode: number; stdout: string; stderr: string };
        const env = (await window.localPi!.refreshEnvironment()) as PiEnvironment;
        set({ env });
        if (res.exitCode === 0) {
          pushNotification({ kind: 'success', title: zh ? `本地 pi 已升级到 ${env.systemVersion ?? '最新'}` : `Local pi upgraded to ${env.systemVersion ?? 'latest'}`, time: '刚刚' });
        } else {
          pushNotification({ kind: 'error', title: zh ? '本地 pi 升级失败' : 'Local pi upgrade failed', body: res.stderr || res.stdout || `exit ${res.exitCode}`, time: '刚刚' });
        }
      } catch (e) {
        pushNotification({ kind: 'error', title: zh ? '本地 pi 升级失败' : 'Local pi upgrade failed', body: String((e as Error).message ?? e), time: '刚刚' });
      } finally {
        set({ packageBusy: undefined });
      }
    },
    disconnectRun: (key) => {
      void attempt(() => window.localPi!.close(key));
    },

    notify: (n) => pushNotification(n),
  };
});

/**
 * 导航历史记录器：任何视图/会话切换（用户点击、程序化兜底跳转）都入栈，
 * 相邻重复去重、上限 50。navPlayback 置位期间（前进/后退回放）不记录，
 * 否则回放会截断前进分支。与 ZCode 只在“用户主动选择”处 push 等价，
 * 因为这里的入口动作本来就全部源自用户操作。
 */
usePiStore.subscribe((state, prev) => {
  if (navPlayback) return;
  if (state.view === prev.view && state.selectedKey === prev.selectedKey) return;
  const entry: NavEntry = state.view === 'chat' && state.selectedKey ? { view: 'chat', key: state.selectedKey } : { view: state.view };
  const next = pushNavEntry(state.navHistory, entry);
  if (next !== state.navHistory) usePiStore.setState({ navHistory: next });
});

export function canNavBack(state: PiReplicaState): boolean {
  return navCanGoBack(state.navHistory);
}

export function canNavForward(state: PiReplicaState): boolean {
  return navCanGoForward(state.navHistory);
}

/**
 * 自动化乐观气泡的可见文本：会话建立前显示在临时聊天面（selectedKey 为空），
 * 切到目标会话后一直显示到真实消息回显进历史（hasUserMessage）为止。
 * 用户中途切到别的会话则隐藏，不打扰。
 */
export function automationLaunchPrompt(
  state: { automationLaunch?: { prompt: string; sessionKey?: string }; selectedKey: string | null },
  hasUserMessage: boolean,
): string | undefined {
  const launch = state.automationLaunch;
  if (!launch || hasUserMessage) return undefined;
  return launch.sessionKey === undefined
    ? (state.selectedKey ? undefined : launch.prompt)
    : (state.selectedKey === launch.sessionKey ? launch.prompt : undefined);
}

// -- derived selectors (pure, exported for tests) -------------------------------

export function currentRunOf(state: PiReplicaStore): PiRun | undefined {
  return state.runs.find((r) => r.key === state.selectedKey);
}

export function currentSessionOf(state: PiReplicaStore): PiSession | undefined {
  return state.sessions.find((s) => s.key === state.selectedKey);
}

export function sessionTitleOf(state: PiReplicaStore): string {
  const run = currentRunOf(state);
  if (run) return state.titles[run.key] ?? state.renames[run.key] ?? currentSessionOf(state)?.name ?? state.pendingPrompt ?? '新桌面会话';
  const session = currentSessionOf(state);
  return session ? state.renames[session.key] ?? session.name : state.automationLaunch?.name ?? '';
}

export function cwdOf(state: PiReplicaStore): string | undefined {
  return currentRunOf(state)?.cwd ?? currentSessionOf(state)?.cwd;
}

// dev 调试出口：CDP/控制台可直接读 store 快照（生产构建为 no-op）。
if (typeof window !== 'undefined' && (import.meta as { env?: { DEV?: boolean } }).env?.DEV) (window as unknown as Record<string, unknown>).__piStore = usePiStore;
