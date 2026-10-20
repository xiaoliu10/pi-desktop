import { singleAsyncDetails, workflowDetails } from '../../shared/subagent-workflow';
import { createContext } from 'react';
import type { ChatMessage, ToolPart } from '../replica/contracts';
import { executionTurns, type ChatTurn } from '../replica/chat/execution';
import { historyToMessages } from './adapter';
import type { PiEntry } from '../../shared/pi';
import { findAdapter } from './subagent-registry';

/**
 * 子代理转录 → 主对话同构轮次：插件上报的 messages 就是 pi 消息对象，
 * 包装成 PiEntry 走同一套 historyToMessages + executionTurns，
 * 从而直接复用 TurnArticle/ToolCard/ExecutionNote 渲染（与主对话完全一致）。
 * turnKey 参与消息 id，避免多个子代理的轮次缓存互相串扰；epoch 参与缓存键：
 * 滑动尾窗（每次取最近 60 条）里同一下标会变成另一条消息，不换键会命中旧缓存。
 *
 * 计时起点（startedAt）：executionTurns 用每轮首条 user 消息的时间戳当 startedAt，
 * 而插件上报的转录消息不带时间戳。没有起点时 ElapsedTime 直接返回 null，子代理详情
 * 里就看不到「已工作 X」——#147 把 epoch 这个假值从 timestamp 里去掉之后留下的缺口。
 * 这里用调用方传入的子代理**真实** startedAt 兜底（它来自主进程 status.json 快照），
 * 消息自身有真实时间时仍以消息为准。绝不拿版本号/当前时间编造。*/
export function subagentTranscriptTurns(messages: SubagentChild['messages'], turnKey: string, epoch?: number, startedAt?: number, endedAt?: number): ChatTurn[] {
  // epoch 是「同一下标内容变化时击穿 messageCache」的缓存版本号，绝不能放进 timestamp：
  // 渲染层把 timestamp 当 Unix 毫秒与 Date.now() 相减，epoch=1 会显示成「已工作 49 万小时」。
  // epoch 只进 entry id（缓存命名空间）；消息自身没有真实时间就留空。
  const epochNs = epoch === undefined ? '' : `:e${epoch}`;
  const entries = messages.map((message, i) => {
    const raw = message && typeof message === 'object' ? (message as Record<string, unknown>).timestamp : undefined;
    const time = typeof raw === 'number' ? raw : typeof raw === 'string' ? Date.parse(raw) : NaN;
    return {
      type: 'message',
      id: `${turnKey}${epochNs}:${i}`,
      ...(Number.isFinite(time) ? { timestamp: time } : {}),
      message,
    } as unknown as PiEntry;
  });
  const turns = executionTurns(historyToMessages(entries));
  const validStart = Number.isFinite(startedAt) && (startedAt as number) > 0 ? startedAt : undefined;
  // endedAt 仅在子代理已结束（调用方传入真实 lastUpdate）且不早于起点时生效。
  const validEnd = validStart !== undefined && Number.isFinite(endedAt) && (endedAt as number) >= validStart ? endedAt : undefined;
  if (validStart === undefined) return turns;
  // 真实计时锚到最后一条 assistant 轮（即当前/最近一次执行），而不是「首条消息」：
  // 传进来的 messages 可能是截断后的尾窗（面板提示「仅显示最近消息」），也可能是
  // 多轮子代理——把 startedAt 写在 messages[0] 上会变成第一轮的起点，不是子代理开始时刻。
  // 绝不修改 turn 对象（executionTurns 的 turnCache 会共享同一引用），必须复制替换。
  let anchor = -1;
  for (let i = turns.length - 1; i >= 0; i -= 1) if (turns[i]!.role === 'assistant') { anchor = i; break; }
  if (anchor === -1) return turns;
  const next = turns.slice();
  // 真实时间戳优先：消息/执行轮已有真实 startedAt/endedAt 时不覆盖，只在缺失时用
  // status.json 快照兜底。endedAt 还必须不早于最终采用的 startedAt。
  const anchored = turns[anchor]!;
  const started = anchored.startedAt ?? validStart;
  let ended = anchored.endedAt ?? validEnd;
  if (ended !== undefined && ended < started) ended = undefined;
  // 显式覆盖 endedAt（不能条件展开）：锚定轮自带的逆序 endedAt 必须被替换成
  // undefined，展开旧对象会把它原样带回（INVALID_END 回归：endedAt < startedAt）。
  next[anchor] = { ...anchored, startedAt: started, endedAt: ended };
  return next;
}

/**
 * 运行中（含排队中）子代理数量。主对话持续提示条与「切换/断开会话」拦截共用
 * 同一个判定：一个会话里只要有子代理还在跑，就不该让用户在不知情的情况下离开
 * 或断开——断开会杀掉持有子代理的 pi 进程，子代理随之消失且不可恢复。
 * 与 SubagentPanel 的 running 分组同源（同一批 SubagentChild 状态），不另造判定。
 */
export function runningSubagents(children: SubagentChild[]): SubagentChild[] {
  return children.filter(c => c.status === 'running' || c.status === 'queued');
}

export const SubagentNavigation = createContext<((callId?: string) => void) | undefined>(undefined);
export type ChildState = 'running' | 'queued' | 'completed' | 'failed' | 'interrupted' | 'unknown' | 'skipped' | 'recovered';
export interface SubagentChild { id: string; callId: string; agent: string; task: string; mode: string; status: ChildState; model?: string; messages: Record<string, unknown>[]; error?: string; tokens?: number; turns?: number; cost?: number; recovered?: boolean; /** workflow/async 子任务的插件自有键（childId/'single'）：详情面板据此按需拉子会话转录。 */ childKey?: string;
  /** 真实开始时刻（主进程从 status.json 快照读出，经 recoverSubagents 轮询到达）。
   *  转录消息自身不带时间戳，详情面板计时条用它作为整轮起点；缺失则不计时，绝不编造。 */
  startedAt?: number;
  /** 终态时刻（status.json lastUpdate）；仅在子代理已结束时用于「用时」，运行中为 undefined。 */
  endedAt?: number }

const obj = (x: unknown): Record<string, any> | undefined => x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, any> : undefined;
const text = (x: unknown): string => typeof x === 'string' ? x : '';

/** Backward-compatible check: does this tool part have subagent details?
 *  Delegates to the adapter registry's detect logic. */
export function officialSubagentDetails(part: ToolPart) {
  const adapter = findAdapter(part);
  return adapter ? obj(part.resultDetails) : undefined;
}

export interface RecoveredSubagent { callId: string; status: string; details?: unknown; error?: string; startedAt?: number; updatedAt?: number }

function parseRecoveredDetails(d: unknown) {
  const details = obj(d);
  if (!details || !['single', 'parallel', 'chain'].includes(details.mode) || !Array.isArray(details.results)) return null;
  return details;
}

export function projectSubagents(messages: ChatMessage[], parentRunning: boolean, recovered?: RecoveredSubagent[]): SubagentChild[] {
  const children: SubagentChild[] = [];
  const seenCallIds = new Set<string>();
  // callId → 主进程磁盘快照（含真实 startedAt/updatedAt，live 与 recovered 路径都靠它补时间）。
  const recByCall = new Map<string, RecoveredSubagent>();
  for (const rec of recovered ?? []) if (!recByCall.has(rec.callId)) recByCall.set(rec.callId, rec);
  const FINISHED: ReadonlySet<string> = new Set(['completed', 'failed', 'interrupted', 'skipped']);
  // startedAt 可以从磁盘快照取（它是子代理的真实启动时刻，状态新旧都成立）。
  // 显示状态不在这里改写（recovered-only 恒为 recovered、live 以 adapter 为准）。
  // endedAt 只能在磁盘快照自身已终态时取其 lastUpdate：磁盘仍 running 时，
  // lastUpdate 只是最近一次轮询时刻，不是结束时刻，不能拿来当「用时」终点。
  // orphan 顶层 status 已与指针路径同口径（149-2：生产者回规范化状态），FINISHED
  // 判定对 orphan 终态同样成立；unknown（幽灵降级）永不算完成。
  const withTiming = (child: SubagentChild): SubagentChild => {
    const rec = recByCall.get(child.callId);
    // 带 childKey 的子卡只用自己的已验证时钟（生产者在 child status.json 通过身份/
    // 时间校验后附到行上，adapter 透传）：record 级时钟属于 workflow/单跑本身，投影
    // 给每个 child 会把「启动前的等待」算进 child 用时（149-3）。无 child 时间就不
    // 计时，绝不拿父时间兑底。无 childKey 的卡（official 适配器结果、workflow 占位
    // 卡）才用 record 时钟——它们本来就是那个 record 的主体。
    if (!rec || child.childKey !== undefined) return child;
    const startedAt = Number.isFinite(rec.startedAt) && (rec.startedAt as number) > 0 ? rec.startedAt : child.startedAt;
    const endedAt = FINISHED.has(rec.status || '') && Number.isFinite(rec.updatedAt) && (rec.updatedAt as number) >= (startedAt ?? 0)
      ? rec.updatedAt : child.endedAt;
    return { ...child, startedAt, endedAt };
  };

  for (const turn of executionTurns(messages)) {
    if (turn.role !== 'assistant') continue;
    for (const part of turn.steps) {
      if (part.kind !== 'tool') continue;
      // Use the adapter registry: find the first adapter that detects this part's format.
      const callId = part.callId || part.id;
      // A verified async snapshot updates the SAME call, not an extra recovered
      // task. Legacy synchronous results remain authoritative as before.
      const rec = recovered?.find(r => r.callId === callId && (workflowDetails(r.details, callId) || singleAsyncDetails(r.details, callId)));
      const live = workflowDetails(part.resultDetails, callId) || singleAsyncDetails(part.resultDetails, callId);
      const disk = rec && (workflowDetails(rec.details, callId) || singleAsyncDetails(rec.details, callId));
      const useDisk = live && disk && live.runId === disk.runId && (!live.snapshotAt || !disk.snapshotAt || disk.snapshotAt >= live.snapshotAt);
      const source = useDisk ? { ...part, resultDetails: rec!.details } : part;
      const adapter = findAdapter(source);
      if (!adapter || seenCallIds.has(callId)) continue;
      seenCallIds.add(callId);
      children.push(...adapter.parse(source, parentRunning).map(withTiming));
    }
  }

  // 合并磁盘恢复的子代理：父进程崩溃后扩展持久化的最后快照。
  if (recovered && recovered.length) {
    for (const rec of recovered) {
      if (seenCallIds.has(rec.callId)) continue;
      const workflow = workflowDetails(rec.details, rec.callId);
      if (workflow) {
        const part: ToolPart = { kind: 'tool', id: rec.callId, callId: rec.callId, tool: 'subagent', phase: 'progress', status: 'running', summary: '', resultDetails: workflow };
        const adapter = findAdapter(part);
        if (adapter) children.push(...adapter.parse(part, parentRunning).map(c => withTiming({ ...c, recovered: true })));
        seenCallIds.add(rec.callId);
        continue;
      }
      const d = parseRecoveredDetails(rec.details);
      if (!d) {
        children.push(withTiming({ id: `${rec.callId}:0`, callId: rec.callId, mode: 'single', agent: '子代理', task: rec.error || '（父任务已重启，进度已从磁盘恢复）', status: 'recovered', messages: [], error: rec.error }));
        continue;
      }
      for (let i = 0; i < d.results.length; i++) {
        const r = obj(d.results[i]);
        const usage = obj(r?.usage);
        const child: SubagentChild = {
          id: `${rec.callId}:${i}`, callId: rec.callId, mode: d.mode,
          agent: text(r?.agent) || '子代理', task: text(r?.task),
          status: 'recovered', model: text(r?.model) || undefined,
          messages: Array.isArray(r?.messages) ? r.messages.filter((m: unknown) => obj(m)) : [],
          error: text(r?.errorMessage) || text(r?.stderr) || rec.error,
          tokens: usage && typeof usage.input === 'number' && typeof usage.output === 'number' ? usage.input + usage.output + (usage.cacheRead || 0) + (usage.cacheWrite || 0) : undefined,
          turns: typeof usage?.turns === 'number' ? usage.turns : undefined,
          cost: typeof usage?.cost === 'number' ? usage.cost : undefined,
          recovered: true,
        };
        children.push(withTiming(child));
      }
    }
  }

  return children;
}
