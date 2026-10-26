import fs from 'node:fs';
import path from 'node:path';
import { canonical } from './session-index';
import type { AccessMode } from '../../shared/access-mode';
import type { PiSession } from '../../shared/pi';

/**
 * 跨会话交接（desktop_handoff）：A 会话把排查结论/任务以一个 user 回合投递给
 * 目标项目的 B 会话——项目级记忆、MCP、权限各自隔离，上下文连续。
 *
 * 目标解析（默认）：项目目录归一化后，取该项目下「未归档、非副驾、Desktop
 * 自建」的最近更新会话；已连接的活跃 run 优先（即使文件 mtime 更旧）。投递：
 * 连着就走 followUp（运行中天然排队），没连着就按 sourceKey 重连后投递。
 *
 * 与 automation-service 的区别：交接是即时、一次性、由会话内模型显式发起的，
 * 不经过 automations.json 调度，也不新建独立会话（用户明确要复用既有会话）。
 */

export interface HandoffTarget {
  key: string;
  /** true=已有活跃 run（立即/排队）；false=按 sourceKey 重连后投递。 */
  connected: boolean;
  status?: string;
  sessionName?: string;
  /** 投递结果：started=空闲已开始；queued=运行中已排队；reconnected=重连后开始。 */
  disposition: 'started' | 'queued' | 'reconnected';
}

export interface HandoffBridgeContext {
  cwd: string;
  /** 发起会话的 runtime key（信头展示用，不作为信任边界）。 */
  sourceSessionKey?: string;
  permission: AccessMode;
  stopping?: boolean;
}

interface ConnectedRun {
  key: string;
  cwd: string;
  status?: string;
  sidecarOf?: string;
}

interface HandoffBackend {
  runs(): ConnectedRun[];
  prompt(key: string, text: string, behavior: 'followUp'): Promise<string | undefined>;
  connect(input: { sourceKey: string; cwd: string; trustProject: false; permission: AccessMode }): Promise<{ key: string }>;
}

interface HandoffPorts {
  index: { scan(): PiSession[] };
  archivedKeys: () => string[];
  backend: HandoffBackend;
  /** 目标会话记忆的访问模式（重连时沿用用户为该会话选过的模式）。 */
  rememberedMode: (key: string) => AccessMode | undefined;
}

interface ResolvedTarget {
  key: string;
  connected: boolean;
  status?: string;
  sessionName?: string;
  cwd: string;
}

const MESSAGE_MAX = 20_000;

/** 交接信封：结构化信头 + 原样正文。信头让 B 的模型知道这不是用户当面输入，
 *  以及任务来自哪个项目/会话；不冒充 system，就是一个普通 user 回合。 */
export function handoffEnvelope(input: { message: string; sourceCwd: string; sourceName?: string; now: Date }): string {
  const when = input.now.toLocaleString();
  const origin = input.sourceName?.trim() || path.basename(input.sourceCwd) || input.sourceCwd;
  return [
    '🔀 【会话交接】',
    `来自项目「${origin}」（${input.sourceCwd}）的另一个会话在 ${when} 转交了以下任务。`,
    '这是该会话排查/工作后整理的自包含上下文，请直接据此继续处理；需要原始细节时按其中的文件路径自行读取。',
    '',
    '--- 交接内容开始 ---',
    input.message.trim(),
    '--- 交接内容结束 ---',
  ].join('\n');
}

export class HandoffService {
  /** 进程内幂等：模型重试/并行重复调用同一交接只投递一次（#161 双投递教训）。
   *  保存投递 Promise 而不是先写标志：并发第二次会等待同一结果，不会重复投递。 */
  private inFlight = new Map<string, Promise<HandoffTarget>>();

  constructor(private ports: HandoffPorts) {}

  private candidates(projectPath: string): PiSession[] {
    let target: string;
    try { target = canonical(projectPath); } catch { throw new Error('项目路径无效'); }
    const archived = new Set(this.ports.archivedKeys());
    const sameCwd = (cwd: string) => { try { return canonical(cwd) === target; } catch { return false; } };
    return this.ports.index.scan()
      .filter(s => sameCwd(s.cwd) && s.owned && !s.sidecarOf && !s.parentSession && !archived.has(s.key) && !s.oversized)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  resolveTarget(input: { projectPath: string; sessionKey?: string }): ResolvedTarget {
    if (!input.projectPath || !path.isAbsolute(input.projectPath)) throw new Error('必须指定目标项目的绝对路径（projectPath）');
    if (!fs.existsSync(input.projectPath) || !fs.statSync(input.projectPath).isDirectory()) throw new Error('目标项目目录不存在');
    const list = this.candidates(input.projectPath);
    const connected = new Map(this.ports.backend.runs().filter(r => !r.sidecarOf).map(r => [r.key, r]));
    if (input.sessionKey) {
      const session = list.find(s => s.key === input.sessionKey);
      if (!session) {
        const all = this.ports.index.scan().find(s => s.key === input.sessionKey);
        if (all && this.ports.archivedKeys().includes(input.sessionKey)) throw new Error('指定的会话已归档，请先取消归档或选择其他会话');
        throw new Error('指定的会话不存在、不属于目标项目或不可用于交接');
      }
      const run = connected.get(session.key);
      return { key: session.key, connected: !!run, status: run?.status, sessionName: session.name, cwd: session.cwd };
    }
    // 已连接的活跃 run 优先（即便其文件 mtime 不是最新）；否则取最近更新的文件。
    const connectedHere = list.filter(s => connected.has(s.key)).sort((a, b) => b.updatedAt - a.updatedAt)[0];
    const session = connectedHere ?? list[0];
    if (!session) throw new Error(`项目 ${input.projectPath} 下没有可复用的未归档会话；请先在该项目创建会话，或显式指定 sessionKey`);
    const run = connected.get(session.key);
    return { key: session.key, connected: !!run, status: run?.status, sessionName: session.name, cwd: session.cwd };
  }

  /** 供模型先查询可选目标（action=list），不产生投递。 */
  listTargets(projectPath: string) {
    if (!projectPath || !path.isAbsolute(projectPath)) return [];
    const connected = new Map(this.ports.backend.runs().filter(r => !r.sidecarOf).map(r => [r.key, r]));
    return this.candidates(projectPath).slice(0, 10).map(s => ({
      key: s.key, name: s.name, updatedAt: s.updatedAt,
      connected: connected.has(s.key), status: connected.get(s.key)?.status ?? null,
    }));
  }

  async deliver(input: {
    projectPath: string;
    sessionKey?: string;
    message: string;
    idempotencyKey?: string;
    context: HandoffBridgeContext;
    now?: Date;
  }): Promise<{ target: HandoffTarget; duplicated: boolean }> {
    const idemKey = input.idempotencyKey?.slice(0, 200);
    if (idemKey && this.inFlight.has(idemKey)) {
      return { target: await this.inFlight.get(idemKey)!, duplicated: true };
    }
    const delivery0 = this.performDelivery(input);
    const delivery = delivery0.catch((error) => {
      // 投递失败（目标忙/重连失败）后允许同幂等键重试，不缓存 rejected Promise。
      if (idemKey) this.inFlight.delete(idemKey);
      throw error;
    });
    if (idemKey) this.inFlight.set(idemKey, delivery);
    const target = await delivery;
    return { target, duplicated: false };
  }

  private async performDelivery(input: {
    projectPath: string;
    sessionKey?: string;
    message: string;
    idempotencyKey?: string;
    context: HandoffBridgeContext;
    now?: Date;
  }): Promise<HandoffTarget> {
    const target0 = this.resolveTarget({ projectPath: input.projectPath, sessionKey: input.sessionKey });
    if (target0.key === input.context.sourceSessionKey) {
      throw new Error('目标会话与发起会话相同；跨会话交接请指定其他项目或其他 sessionKey');
    }
    const envelope = handoffEnvelope({
      message: input.message,
      sourceCwd: input.context.cwd,
      now: input.now ?? new Date(),
    });
    let disposition: HandoffTarget['disposition'];
    if (target0.connected) {
      const dispositionNow = await this.ports.backend.prompt(target0.key, envelope, 'followUp');
      if (dispositionNow === 'handled') throw new Error('目标会话把交接内容当作本地命令消费了，未产生任务回合');
      disposition = dispositionNow === 'queued' ? 'queued' : 'started';
    } else {
      const permission = this.ports.rememberedMode(target0.key) ?? 'ask';
      await this.ports.backend.connect({ sourceKey: target0.key, cwd: target0.cwd, trustProject: false, permission });
      await this.ports.backend.prompt(target0.key, envelope, 'followUp');
      disposition = 'reconnected';
    }
    const target: HandoffTarget = { key: target0.key, connected: target0.connected, status: target0.status, sessionName: target0.sessionName, disposition };
    return target;
  }
}

/** Agent-facing bridge：desktop_handoff 扩展把请求编码进保留 ui.input 载荷，
 *  backend 异步拦截后调用本函数。绝不抛错（与 runAutomationBridge 同一约定）。
 *  投递可能触发目标会话重连（数百 ms），调用方应 await 后再回 ui 应答。 */
export async function runHandoffBridge(service: HandoffService | undefined, context: HandoffBridgeContext, payloadRaw: string): Promise<Record<string, unknown>> {
  try {
    if (context.stopping) return { ok: false, error: '会话正在停止，无法交接' };
    if (!service) return { ok: false, error: '交接服务不可用' };
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(payloadRaw); } catch { return { ok: false, error: '请求格式无效' }; }
    if (payload.action === 'list') {
      const projectPath = String(payload.projectPath ?? context.cwd);
      return { ok: true, action: 'list', sessions: service.listTargets(projectPath) };
    }
    const message = String(payload.message ?? '');
    if (!message.trim() || message.length > MESSAGE_MAX) return { ok: false, error: `message 必须为 1–${MESSAGE_MAX} 字符的自包含任务说明` };
    const projectPath = payload.projectPath !== undefined ? String(payload.projectPath) : context.cwd;
    const sessionKey = payload.sessionKey !== undefined ? String(payload.sessionKey) : undefined;
    const idempotencyKey = payload.idempotencyKey !== undefined ? String(payload.idempotencyKey) : undefined;
    const { target, duplicated } = await service.deliver({ projectPath, sessionKey, message, idempotencyKey, context });
    return { ok: true, action: 'send', target, duplicate: duplicated };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
