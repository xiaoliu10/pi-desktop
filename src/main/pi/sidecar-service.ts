import fs from 'node:fs';
import path from 'node:path';
import type { PiEvent, PiRun, PiSession } from '../../shared/pi';
import { OversizedSessionError } from './session-size';
import type { PiBackend } from './backend';
import type { IndexPort } from './index-port';
import { sidecarSummaryPrompt } from './sidecar-summary';

/** 主会话摘要注入开关/预算：桌面设置暂无入口，先走 env（与 verify-gate 的
 *  PI_VERIFY_CMD 同风格）；off = 完全退回旧行为（无背景注入）。 */
function summaryBudgetFrom(env: NodeJS.ProcessEnv = process.env): { maxMessages: number; maxChars: number; perMessageChars: number } | undefined {
  if (env.PI_SIDECAR_SUMMARY === 'off') return undefined;
  const num = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : d; };
  return {
    maxMessages: num(env.PI_SIDECAR_SUMMARY_MAX_MESSAGES, 12),
    maxChars: num(env.PI_SIDECAR_SUMMARY_MAX_CHARS, 4000),
    perMessageChars: num(env.PI_SIDECAR_SUMMARY_PER_MESSAGE, 600),
  };
}

/** One retained, independently persisted conversation per main session. */
export class SidecarService {
  private bindings = new Map<string, string>();
  private pending = new Map<string, Promise<PiRun>>();
  private readonly mapFile: string;

  constructor(private backend: PiBackend, private index: IndexPort, private dataDir: string, private onEvent: (e: PiEvent) => void) {
    this.mapFile = path.join(dataDir, 'sidecar-map.json');
    try {
      const value: unknown = JSON.parse(fs.readFileSync(this.mapFile, 'utf8'));
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [main, sidecar] of Object.entries(value)) {
          if (main && typeof sidecar === 'string' && sidecar) this.bindings.set(main, sidecar);
        }
      }
    } catch { /* Missing or corrupt mapping never prevents application startup. */ }
  }

  bindingOf(mainKey: string): string | undefined {
    if (typeof mainKey !== 'string' || !mainKey) throw new Error('主会话无效');
    return this.bindings.get(mainKey);
  }

  ensure(mainKey: string): Promise<PiRun> {
    this.bindingOf(mainKey); // Validate before looking up an in-flight launch.
    const pending = this.pending.get(mainKey);
    if (pending) return pending;
    const task = this.connect(mainKey).finally(() => this.pending.delete(mainKey));
    this.pending.set(mainKey, task);
    return task;
  }

  // 并发不变量：`await backend.connect` 是 connect() 里唯一的 await 点，其后的
  // copy-on-write 读旧快照→写回全同步——两个 mainKey 并发 ensure 不会互相覆盖。
  // 若在此函数里新增 await，必须改为在写回处重新合并最新 bindings。
  private async connect(mainKey: string): Promise<PiRun> {
    const bound = this.bindings.get(mainKey);
    // 绑定指向的文件被外部删除（手动清理/同步冲突）→ 可修复失效：断开（可能仍活着的）旧 run
    // —— fd 还在时追加写孤儿 inode，关闭即丢 —— 清绑定按新建继续。key 是哈希，需经
    // 活跃 run 或索引解析回真实路径再判存在性。文件存在但读失败（oversized 等）→ fail closed。
    if (bound) {
      const boundPath = this.backend.runs().find(r => r.key === bound)?.file
        ?? this.index.scan(true).find(s => s.key === bound)?.path
        ?? this.backend.ownedSessionPath(bound);
      if (boundPath === undefined || !fs.existsSync(boundPath)) {
        for (const r of this.backend.runs()) if (r.key === bound) this.backend.close(r.key);
        const next = new Map(this.bindings);
        next.delete(mainKey);
        this.persist(next);
        this.bindings = next;
        return this.connect(mainKey);
      }
    }
    const active = bound && this.backend.runs().find(r => r.key === bound);
    if (active) return active;
    const context = this.backend.sessionContext(mainKey);
    const cwd = context?.cwd ?? this.requireMainSession(mainKey).cwd;
    // 主会话摘要（最近几轮，预算截断）注入 systemPrompt：副驾是独立会话，否则
    // 用户「接着主对话的问题」追问时它无从知道指代对象。摘要只需要分支尖端窗口：
    // 订阅（refcount，已连接会话不产生额外 worker 订阅）→ 同步读 256 条尾窗 →
    // 释放本路径的引用。注入失败（索引坏/超限/镜像不可用）不阻塞副驾启动——
    // 退化为无背景（与旧行为一致）。
    let summary: string | undefined;
    try {
      const budget = summaryBudgetFrom();
      if (budget) {
        await this.index.subscribe(mainKey);
        try {
          const branch = this.index.branchTail(mainKey, 256) ?? [];
          summary = sidecarSummaryPrompt(branch, budget) || undefined;
        } finally {
          this.index.unsubscribe(mainKey);
        }
      }
    } catch { /* 摘要失败不阻塞副驾 */ }
    const input = { cwd, trustProject: context?.trustProject ?? false, permission: 'ask' as const, tools: ['read'], sidecarOf: mainKey, ...(summary ? { systemPrompt: summary } : {}) };
    let resume: string | undefined;
    if (bound) {
      // Fail closed on a stale/corrupt binding: never resume a main or external file.
      const session = this.requireBoundSession(bound);
      if (!session.owned || session.sidecarOf === undefined) throw new Error('辅助对话绑定无效，请检查 sidecar-map.json');
      resume = bound;
    }
    const run = await this.backend.connect({ ...input, ...(resume ? { sourceKey: resume } : {}) });
    const next = new Map(this.bindings);
    next.set(mainKey, run.key);
    try {
      this.persist(next);
    } catch (error) {
      this.backend.close(run.key);
      throw error;
    }
    this.bindings = next;
    this.onEvent({ type: 'sessions-changed' });
    return run;
  }

  /** 主会话元数据（镜像同步读）：缺失时与旧 history() 抛错同口径 fail-closed。 */
  private requireMainSession(mainKey: string): PiSession {
    const session = this.index.sessionMeta(mainKey);
    if (!session) throw new Error('会话不存在、不可读或不在选定目录中。');
    return session;
  }
  private requireBoundSession(bound: string): PiSession {
    const session = this.index.sessionMeta(bound);
    if (!session) throw new Error('会话不存在、不可读或不在选定目录中。');
    // 超限降级会话只有元数据：resume 后续读取必抛 OversizedSessionError，与旧 history()
    // 的 fail-closed 同口径在此提前拦截（结构化字段判定，与 backend.requireSourceSession 一致）。
    if (session.oversized) throw new OversizedSessionError(session.path, session.size);
    return session;
  }

  /** 原子写绑定表：tmp 先删（'wx' 保证 mode 落在新建文件上，陈旧 .tmp 不残留）+ rename。 */
  private persist(next: Map<string, string>): void {
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.rmSync(this.mapFile + '.tmp', { force: true });
    fs.writeFileSync(this.mapFile + '.tmp', JSON.stringify(Object.fromEntries(next), null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(this.mapFile + '.tmp', this.mapFile);
  }

  async send(mainKey: string, text: string): Promise<void> {
    const run = await this.ensure(mainKey);
    await this.backend.prompt(run.key, text, 'followUp');
  }
}
