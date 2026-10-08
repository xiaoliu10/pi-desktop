import { THINKING_LEVELS, type PiImage, type ThinkingLevel } from '../../shared/composer';
import { isAccessMode, type AccessMode } from '../../shared/access-mode';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PiEnvironment, PiEvent, PiRun, PiUiRequest } from '../../shared/pi';
import { PiRpcClient, piLogDir } from './rpc-client';
import { SessionIndex, canonical, fileKey } from './session-index';
import { runAutomationBridge, SCHEDULE_GUIDANCE } from './automation-bridge';
import { cacheHitRateFromTotals, summarizeContext } from './context-details';
import { detectThirdPartySubagent, migrateOldSubagentExtension, persistSubagentEvent } from './official-subagent';
import { clearMemoryEnv, memorySessionEnv } from './memory-bridge';
import { repairPackages } from './packages-repair';
import { RetryGroups } from './retry-groups';
import { loadContinuations, recordContinuation, resolveContinuation, saveContinuations } from './session-continuations';
/** prompt 出栈前登记的图片 sidecar：pi 的 queue_update 只回文本，权威队列到达后
 *  按 文本+behavior+出现次序 把图接回。at 用于过期清理（暂存一直未被任何 queue_update
 *  确认 = pi 已直接分发或丢弃该项，不能再把图配给后来同文本的纯文本排队项）。 */
interface StagedQueueImage { text: string; behavior: 'steer' | 'followUp'; images: PiImage[]; at: number }
/** 未被 queue_update 确认的暂存图最多保留 2 分钟。 */
const QUEUE_IMAGE_STAGE_TTL = 120_000;
/** 假 running 自愈：run 无任何 pi 事件超过该时长即视为可疑，主动向 pi 本体 get_state 核实。
 *  真实在跑（静默长工具/扩展审计，isStreaming 恒真）只被周期性轻询；
 *  pi 已空闲而 Desktop 没收到结算事件（agent_settled 丢失/终止路径不发，实测 goal 完成
 *  后计时条永续 1.5h+）则拉直为 idle。 */
const STUCK_SILENCE_MS = 120_000;
/** 重试链持有期（holding：组>1 或已排队续接）的静默阈值更宽：组间退避最长 20 分钟、
 *  续接后的模型响应也可能持续数分钟，100% 无事件满 10 分钟才值得核实。 */
const RETRY_HOLDING_SILENCE_MS = 600_000;
/** 大会话明细阈值：会话文件 ≥8MiB 时跳过 get_messages——它会把全量历史（含图片 base64）
 *  序列化成单帧 RPC 响应，逼近 16MiB 帧上限；留一半裕量给系统上下文增长。
 *  上下文占比是非核心的悬浮统计，不能为它冒断会话的风险。 */
const CONTEXT_BREAKDOWN_MAX_SESSION_BYTES = 8 * 1024 * 1024;
const STUCK_WATCHDOG_INTERVAL_MS = 30_000;
type QueuedInput = NonNullable<PiRun['queue']>[number];
interface Running { recheckTimer?: ReturnType<typeof setTimeout>; stopQueueSnapshot?: QueuedInput[]; settlement?: { token: string; timer: ReturnType<typeof setTimeout> }; activity: number; /** 假 running 自愈用：全部 pi 事件计数与最近事件时刻 */ eventCount: number; lastEventAt: number; verifying?: boolean; promptSequence: number; retryUncertain: boolean; stopUnconfirmed: boolean; retry: RetryGroups; retryReady: boolean; retryEntryId?: string; deferredQueue: QueuedInput[]; stopEpoch: number; policyReady: boolean; client: PiRpcClient; view: PiRun; input: { cwd: string; trustProject: boolean; permission: AccessMode; executionMode?: Exclude<AccessMode, 'plan'>; file: string; origin: string; systemPrompt?: string; tools?: string[]; model?: string }; dialogs: Map<string, { timer?: ReturnType<typeof setTimeout>; method: string; request: PiUiRequest }>; queueImages: StagedQueueImage[] }
export class PiBackend {
  private active = new Map<string, Running>();
  private watchdog: ReturnType<typeof setInterval> | undefined;
  /** 记忆衔接：main 在 SettingsService 就绪后注入；每次 launch 现取最新开关与目录。 */
  memoryOptions: (() => { enabled: boolean; dir: string }) | undefined;
  /** main 在 AutomationService 就绪后注入；desktop_schedule 工具经 automation-bridge 读写定时任务。 */
  automations: import('./automation-bridge').AutomationBridgeService | undefined;
  /** main 提供：编辑重发 fork 后迁移用户 rename（旧 key → 新 key，复制不删）。 */
  onContinuation?: (fromKey: string, toKey: string) => void;
  /** 测试注入点：替换 PiRpcClient 构造（生产不设）。 */
  clientFactory?: (command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) => PiRpcClient;
  constructor(private env: PiEnvironment, private index: SessionIndex, private ownedRoot: string, private policyPath: string, private emit: (e: PiEvent) => void, private dataDir?: string) {}
  hasPendingDialogs(key: string) { return (this.active.get(key)?.dialogs.size ?? 0) > 0; }
  /** 待处理的 UI 审批快照（远控页刷新后据此恢复审批卡片）。 */
  pendingDialogs(key: string): Array<{ generation: string; request: PiUiRequest }> {
    const run = this.active.get(key);
    if (!run) return [];
    return [...run.dialogs.values()].map(d => ({ generation: run.view.generation, request: d.request }));
  }
  runs() { return [...this.active.values()].map(x => x.view); }
  private get(key: string) { const run = this.active.get(key); if (!run) throw new Error('会话未由 Desktop 连接'); return run; }
  async connect(input: { sourceKey?: string; cwd?: string; trustProject: boolean; permission: AccessMode; executionMode?: Exclude<AccessMode, 'plan'>; systemPrompt?: string; tools?: string[]; model?: string }): Promise<PiRun> {
    if (input.executionMode !== undefined && (!isAccessMode(input.executionMode) || (input.executionMode as string) === 'plan')) throw new Error('无效执行模式');
    if (!isAccessMode(input.permission)) throw new Error('无效访问模式');
    if (!this.env.supported || !this.env.executable) throw new Error(this.env.diagnostics.join('\n'));
    let cwd = input.cwd, file: string;
    let origin = '';
    if (input.sourceKey) {
      const source = this.index.history(input.sourceKey);
      cwd = source.session.cwd;
      if (!path.isAbsolute(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error('源项目目录已失效；仍可只读查看历史。');
      // 延续重定向：该会话被「编辑重发」fork 过时，后续对话在链尾文件里。
      // attach 与打开目标都按链尾匹配——fork 后活着的 run 挂在旧 key/origin 上，
      // 但它的实际文件已 rebind，直接再 launch 会产生同文件双 pi 进程。
      const map = loadContinuations(this.dataDir);
      const continued = canonical(resolveContinuation(map, source.session.path));
      origin = fileKey(continued);
      const attached = this.active.get(origin) ?? [...this.active.values()].find(r => canonical(resolveContinuation(map, r.input.file)) === continued);
      if (attached) return attached.view;
    }
    if (this.active.size >= 6) throw new Error('最多同时连接 6 个会话，请先断开空闲会话。');
    fs.mkdirSync(this.ownedRoot, { recursive: true });
    this.ownedRoot = fs.realpathSync(this.ownedRoot);
    if (input.sourceKey) {
      const source = this.index.history(input.sourceKey);
      const continuedPath = canonical(resolveContinuation(loadContinuations(this.dataDir), source.session.path));
      if (source.session.owned) {
        // Desktop 自建会话原地续聊；只有外部 CLI 会话才派生副本，
        // 否则每次断开后继续都会 fork 出一条新会话。
        file = continuedPath === canonical(source.session.path) ? source.session.path : continuedPath;
      } else {
        // 外部原件已有 Desktop 副本时，继续最近的那个副本（副本自身被 fork 过则继续其链尾），不再重复 fork。
        const child = this.index.scan().filter(s => s.owned && s.parentSession === source.session.path)
          .sort((x, y) => y.updatedAt - x.updatedAt)[0];
        if (child) {
          const childPath = canonical(resolveContinuation(loadContinuations(this.dataDir), child.path));
          const childKey = fileKey(childPath);
          const activeChild = this.active.get(childKey) ?? this.active.get(child.key);
          if (activeChild) return activeChild.view;
          file = childPath;
        } else {
          // Never open an external CLI file for writing. Preserve all entries on a copy.
          const id = randomUUID(); file = path.join(this.ownedRoot, `${Date.now()}_${id}.jsonl`);
          const sourceHeader = JSON.parse(fs.readFileSync(source.session.path, 'utf8').split('\n')[0]);
          fs.writeFileSync(file, [JSON.stringify({ ...sourceHeader, id, timestamp: new Date().toISOString(), parentSession: source.session.path }), ...source.entries.map(e => JSON.stringify(e)), ''].join('\n'), { flag: 'wx', mode: 0o600 });
        }
      }
    } else {
      const id = randomUUID(); file = path.join(this.ownedRoot, `${Date.now()}_${id}.jsonl`);
    }
    if (!cwd || !path.isAbsolute(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error('项目目录不存在，请选择有效目录。');
    return this.launch({ cwd, file, origin, trustProject: input.trustProject, permission: input.permission, executionMode: input.executionMode, systemPrompt: input.systemPrompt, tools: input.tools, model: input.model });
  }
  private contextRequests = new WeakMap<Running, number>();
  /** 上次明细拉取时间：get_messages 会序列化全量消息（大会话 MB 级），pi 与主进程都会被阻塞，
   *  流式期间按调用频率拉会把事件流掐出空窗（表现为进度卡住后集中刷出）。 */
  private lastBreakdownAt = new WeakMap<Running, number>();
  private refreshContextUsage(run: Running) {
    const { key, generation } = run.view;
    const sequence = (this.contextRequests.get(run) ?? 0) + 1;
    this.contextRequests.set(run, sequence);
    void run.client.request('get_session_stats', {}, 5_000).then(async (data: any) => {
      const active = this.active.get(key);
      if (!active || active.view.generation !== generation || this.contextRequests.get(run) !== sequence) return;
      const cu = data?.contextUsage;
      if (cu && Number.isFinite(cu.tokens) && cu.tokens >= 0 && Number.isFinite(cu.contextWindow) && cu.contextWindow > 0) {
        const percent = Number.isFinite(cu.percent) ? cu.percent : cu.tokens / cu.contextWindow * 100;
        active.view.contextUsage = { tokens: cu.tokens, contextWindow: cu.contextWindow, percent };
      } else {
        // Compaction may temporarily return null usage. Never keep the pre-compaction value.
        active.view.contextUsage = undefined;
      }
      // 同一份 stats 快照里的会话统计：token 明细、费用、消息/工具调用数（状态栏展示）。
      const t = data?.tokens;
      if (t && Number.isFinite(t.total) && t.total >= 0) {
        active.view.stats = {
          tokens: { input: Number(t.input) || 0, output: Number(t.output) || 0, cacheRead: Number(t.cacheRead) || 0, cacheWrite: Number(t.cacheWrite) || 0, total: Number(t.total) || 0 },
          cost: Number.isFinite(data.cost) ? Number(data.cost) : undefined,
          totalMessages: Number.isFinite(data.totalMessages) ? Number(data.totalMessages) : undefined,
          toolCalls: Number.isFinite(data.toolCalls) ? Number(data.toolCalls) : undefined,
        };
      }
      this.emit({ type: 'run', run: { ...active.view } });
      // Proportional breakdown + cache-hit stats：明细是悬浮展示，允许滞后。流式运行中限频 15s 一次；
      // 任务收尾（idle）与首轮始终计算。
      const now = Date.now();
      const busy = active.view.status === 'running' || active.view.status === 'starting';
      if (busy && now - (this.lastBreakdownAt.get(run) ?? 0) < 15_000) return;
      this.lastBreakdownAt.set(run, now);
      // 大会话跳过全量历史明细（计时上限维持 10s 超时不变）：不伪造 breakdown，
      // 旧 breakdown 也已不可信（会话早已增长），替换为明确的空明细。
      // cacheHitRate 只依赖 stats 的 token 分布，仍可如实计算。
      let sessionBytes = Number.MAX_SAFE_INTEGER; // 无法确知大小时按大会话处理（fail closed）
      try { sessionBytes = fs.statSync(run.input.file).size; } catch { /* 文件不可读时同上 */ }
      if (sessionBytes >= CONTEXT_BREAKDOWN_MAX_SESSION_BYTES) {
        active.view.contextDetails = { breakdown: [], method: 'skipped-large-session', cacheHitRate: cacheHitRateFromTotals(data?.tokens), fetchedAt: Date.now() };
        this.emit({ type: 'run', run: { ...active.view } });
        return;
      }
      try {
        const { messages } = await run.client.request('get_messages', {}, 10_000);
        if (this.active.get(key) !== active || this.contextRequests.get(run) !== sequence) return;
        const { summarizeContext } = await import('./context-details');
        active.view.contextDetails = summarizeContext(messages, data?.tokens);
        this.emit({ type: 'run', run: { ...active.view } });
      } catch { /* breakdown is best-effort */ }
    }).catch(() => undefined);
  }

  private async launch(input: Running['input']): Promise<PiRun> {
    if (!fs.existsSync(this.policyPath)) throw new Error("Desktop 工具权限扩展缺失，无法启动执行会话。");
    // pi 会话退出会写回旧 settings 副本抹掉包注册（/goal 等命令消失的根因）——
    // 每次启动会话前按期望列表补回，保证新会话总是带全 packages。
    if (this.dataDir) repairPackages(this.dataDir, this.env.agentDir);
    const key = fileKey(input.file), generation = randomUUID();
    // The policy extension re-reads this file per tool call, so the access
    // mode can change mid-run without restarting the session process.
    const modeFile = path.join(this.ownedRoot, `.mode-${key}`);
    fs.mkdirSync(this.ownedRoot, { recursive: true });
    fs.writeFileSync(modeFile, input.permission, 'utf8');
    const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: this.env.agentDir, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_DESKTOP_PERMISSION: input.permission, PI_DESKTOP_GENERATION: generation, PI_DESKTOP_MODE_FILE: modeFile, PI_DESKTOP_TRUST_PROJECT: input.trustProject ? '1' : '0', PI_DESKTOP_PI_VERSION: this.env.version ?? '' };
    delete env.ELECTRON_RUN_AS_NODE;
    // GUI applications may not inherit the same PATH as a terminal.
    env.PATH = [path.dirname(this.env.executable!), '/opt/homebrew/bin', '/usr/local/bin', env.PATH || ''].join(path.delimiter);
    // Desktop 自带的 ask_user_question 扩展（随 Desktop 默认加载；缺失不阻塞会话）。
    const askPath = path.join(path.dirname(this.policyPath), '..', 'desktop-ask', 'index.mjs');
    const askArgs = fs.existsSync(askPath) ? ['-e', askPath] : [];
    // Desktop 定时任务工具：会话内可创建/管理 automations.json 调度任务（缺失不阻塞会话）。
    const schedulePath = path.join(path.dirname(this.policyPath), '..', 'desktop-schedule', 'index.mjs');
    const scheduleArgs = fs.existsSync(schedulePath) ? ['-e', schedulePath] : [];
    // 记忆衔接扩展：memoryAssist 开启时随会话装载，agent_end 后自动整理记忆。
    const memory = this.memoryOptions?.() ?? { enabled: false, dir: '' };
    const memoryPath = path.join(path.dirname(this.policyPath), '..', 'desktop-memory', 'index.mjs');
    const memoryArgs = memory.enabled && fs.existsSync(memoryPath) ? ['-e', memoryPath] : [];
    // Do not inherit a parent session's (or Desktop's own) memory scope/enable flag:
    // global sessions must land on the plugin default root, project sessions get a
    // freshly computed per-project injection. See memorySessionEnv for the tradeoff.
    clearMemoryEnv(env);
    Object.assign(env, memorySessionEnv(memory, input.cwd, this.env.agentDir));
    // Subagent fallback：仅在用户没有安装第三方 subagent 插件时加载。
    // 检测 agentDir/extensions/ + settings.json packages 里的 subagent 扩展。
    // 旧版 desktop-official-subagent 在 agentDir/extensions/ 里会和 npm 包冲突，
    // 迁移时自动删除旧目录，改用 -e 加载消除冲突。
    migrateOldSubagentExtension(this.env.agentDir);
    const subagentPath = path.join(path.dirname(this.policyPath), '..', 'desktop-subagent', 'index.mjs');
    const subagentArgs = fs.existsSync(subagentPath) && !detectThirdPartySubagent(this.env.agentDir).detected ? ['-e', subagentPath] : [];
    // codemode 采用率引导：非 GPT 系模型对弱 guideline 不敏感，随会话注入
    // 可判定规则 + 运行中提醒（缺失不阻塞会话）。
    const nudgePath = path.join(path.dirname(this.policyPath), '..', 'desktop-codemode-nudge', 'index.mjs');
    const nudgeArgs = fs.existsSync(nudgePath) ? ['-e', nudgePath] : [];
    const args = [
      ...(this.env.launchArgs || []),
      '--mode', 'rpc',
      '--session', input.file,
      '--session-dir', this.ownedRoot,
      input.trustProject ? '--approve' : '--no-approve',
      '-e', this.policyPath,
      '-e', path.join(path.dirname(this.policyPath), 'mcp-bridge.mjs'),
      '-e', path.join(path.dirname(this.policyPath), 'retry-continuation.mjs'),
      ...askArgs,
      ...scheduleArgs,
      ...memoryArgs,
      ...subagentArgs,
      ...nudgeArgs,
      // 调度守则随 desktop-schedule 扩展注入：用户要「定时干活」时引导模型用 desktop_schedule，
      // 而不是在会话里 sleep 等待（会话退出即丢失；与扩展共存亡，缺失时不注入）。
      ...(scheduleArgs.length
        ? ['--append-system-prompt', [input.systemPrompt, SCHEDULE_GUIDANCE].filter(Boolean).join('\n')]
        : input.systemPrompt ? ['--append-system-prompt', input.systemPrompt] : []),
      ...(input.permission === 'plan'
        // 计划模式：只读工具 + ask_user_question（提问无副作用，正好用于澄清需求）+ 任务清单。
        ? ['--tools', [...(input.tools ?? ['read', 'grep', 'find', 'ls']).filter(t => ['read', 'grep', 'find', 'ls'].includes(t)), 'ask_user_question', 'desktop_update_plan'].join(',')]
        : input.tools ? ['--tools', input.tools.join(',')] : []),
      ...(input.model ? ['--model', input.model] : []),
    ];
    const client = (this.clientFactory ?? ((cmd: string, a: string[], cwd: string, e: NodeJS.ProcessEnv) => new PiRpcClient(cmd, a, cwd, e)))(this.env.executable!, args, input.cwd, env);
    // 8–16MiB 盲区取证：会话 ≥8MiB 跳过明细、单帧 ≥16MiB 被丢弃，这个区间里的卡顿/丢帧
    // 只在 client diagnostic 事件里留痕（内存只保留最后一条，close 后即失）——带时间戳
    // 落盘到与 pi-stderr.log 同目录的 pi-rpc.log，供事后排查大会话断连。事件稀少，
    // 不做轮转；目录只建一次；落盘失败静默，绝不能影响会话主流程。
    let rpcLogReady = false;
    const rpcLogPath = path.join(piLogDir, 'pi-rpc.log');
    client.on('diagnostic', message => {
      if (!rpcLogReady) { try { fs.mkdirSync(piLogDir, { recursive: true }); rpcLogReady = true; } catch { return; } }
      fs.appendFile(rpcLogPath, `[${new Date().toISOString()}] ${String(message)}\n`, () => { /* 落盘失败不影响主流程 */ });
    });
    const view: PiRun = { accessMode: input.permission, executionMode: input.permission === 'plan' ? input.executionMode ?? 'ask' : input.permission, key, generation, cwd: input.cwd, file: input.file, status: 'starting', models: [], commands: [], pending: 0 };
    const run: Running = { activity: 0, eventCount: 0, lastEventAt: Date.now(), promptSequence: 0, retryUncertain: false, stopUnconfirmed: false, retry: undefined!, retryReady: false, deferredQueue: [], stopEpoch: 0, policyReady: false, client, view, input, dialogs: new Map(), queueImages: [] };
    run.retry = new RetryGroups(state => {
      view.retryGroup = state;
      if (state?.error) {
        view.error = state.error;
        // A continuation ACK timeout does not prove the command did not start.
        // Keep Stop available until a real settlement/abort confirms quiescence.
        view.status = run.retryUncertain ? 'running' : 'error';
        if (!run.retryUncertain && view.timing) view.timing = { ...view.timing, endedAt: Date.now() };
      }
      if (this.active.get(key) === run) this.emit({ type: 'run', run: { ...view } });
    }, () => this.continueRetryGroup(run));
    this.active.set(key, run); this.emit({ type: 'run', run: { ...view } });
    this.ensureWatchdog();
    client.on('event', event => this.onEvent(run, event));
    client.on('closed', () => {
      if (this.active.get(key) !== run) return;
      this.active.delete(key);
      this.clearSettlement(run); run.retry.dispose(); ++run.stopEpoch;
      if (view.timing && view.timing.endedAt === undefined) view.timing = { ...view.timing, endedAt: Date.now() };
      view.status = 'error';
      const stderr = client.stderrDetail();
      // 红条归因：generic「已退出」只作兑底，已知因果故障优先展示；close() 自身也发
      // SIGTERM，本机主动断开不得表述成系统/外部杀进程。只含故障类别，不泄露 prompt/env。
      const suffix = stderr ? `\npi stderr：${stderr}` : '';
      const cause = client.failureReason?.().trim() ?? '';
      const causal = cause !== '' && cause !== 'pi 连接已关闭' && !cause.startsWith('pi 已退出');
      const exit = client.exitDetail?.() ?? '';
      const how = causal ? cause
        : client.closedLocally?.() ? 'Desktop 已主动断开该会话'
        : `pi 进程已退出${exit ? `（${exit}）` : ''}`;
      view.error = `${how}，请断开后重连。任务未自动重放。${suffix}`;
      this.clearDialogs(run); this.emit({ type: 'run', run: { ...view } }); this.emit({ type: 'closed', key, generation });
    });
    let firstFrameScope = true; // get_state 阶段标记：超时 append 只贴在首帧阶段
    try {
      // 大会话的首帧加载（40MB/700 条含截图的会话实测 60s+）不能按固定 60s 判死——
      // 慢 ≠ 坏。预算按会话规模放宽，超时后重试一次，仍失败才带着规模信息报错。
      const budget = this.startupBudget(run.input.file);
      if (budget > 60_000) { view.stage = 'loading'; this.emit({ type: 'run', run: { ...run.view } }); } // 大会话立刻可见「加载中」
      let firstFrame: any;
      try { firstFrame = await client.request('get_state', {}, budget); }
      catch (e) {
        // 超时不判死：重试一次（RPC 客户端超时会 reject 但 pi 本体仍在加载，请求可重发）。
        if (this.active.get(key) !== run) throw e; // 等待期内 pi 崩溃/用户断开：closed 已移除 run，迟到 run 事件会造僵尸条目
        firstFrame = await client.request('get_state', {}, budget);
      }
      // 首帧成功后广播一次（starting 态带历史加载规模），让 UI 从「正在准备」变成「已连接，正在拉取模型」。
      view.model = firstFrame?.model ? { id: String(firstFrame.model.id), name: String(firstFrame.model.name || firstFrame.model.id), provider: String(firstFrame.model.provider), reasoning: !!firstFrame.model.reasoning, input: Array.isArray(firstFrame.model.input) ? firstFrame.model.input : undefined } : undefined;
      view.stage = undefined; // 历史已加载完，剩余是轻量的 models/commands 拉取
      this.emit({ type: 'run', run: { ...run.view } });
      firstFrameScope = false; // 之后是轻量的 models/commands 拉取，其超时不贴首帧文案
      const state = firstFrame;
      const models = await client.request('get_available_models');
      const commands = await client.request('get_commands');
      if (!run.policyReady) throw new Error('Desktop 工具权限扩展未成功加载，已断开 pi。');
      const cleanModel = (m: any) => ({ id: String(m.id), name: String(m.name || m.id), provider: String(m.provider), reasoning: !!m.reasoning, input: Array.isArray(m.input) ? m.input : undefined });
      view.models = (models?.models || []).map(cleanModel);
      view.model = state?.model ? cleanModel(state.model) : undefined;
      view.commands = (commands?.commands || []).filter((c: any) => !String(c.name).startsWith('desktop-retry-')).map((c: any) => ({ name: String(c.name), description: c.description, source: c.source, path: c.path ?? String(c.sourceInfo?.path ?? '') }));
      view.thinkingLevel = state?.thinkingLevel ?? 'off';
      view.thinkingLevels = (await client.request('get_available_thinking_levels').catch(() => ({levels: []})))?.levels ?? [];
      view.status = state?.isStreaming || state?.isCompacting ? 'running' : 'idle';
      view.stage = undefined;
      this.emit({ type: 'run', run: { ...view } }); this.emit({ type: 'sessions-changed' });
      this.refreshContextUsage(run);
      // 迟加载自愈：扩展/npm 包若在初次拉取后才注册命令（或初次拉取失败），
      // 命令列表会永远空。短延时后复检一次，有新增则更新并广播。
      run.recheckTimer = setTimeout(() => {
        if (run.client !== client || this.active.get(key) !== run) return;
        void client.request('get_commands').then((again: any) => {
          if (this.active.get(key) !== run || run.client !== client) return;
          const list = ((again?.commands || []) as any[]).filter((c: any) => !String(c.name).startsWith('desktop-retry-'))
            .map((c: any) => ({ name: String(c.name), description: c.description, source: c.source, path: c.path ?? String(c.sourceInfo?.path ?? '') }));
          if (list.length > view.commands.length) {
            view.commands = list;
            this.emit({ type: 'run', run: { ...view } });
          }
        }).catch(() => { /* 会话可能已关闭；下次打开补全面板时还会按需重拉 */ });
      }, 8000).unref();
      return { ...view };
    } catch (err) {
      // 首帧（含重试）超时仍失败：红条要能区分「真的坏了」与「太大/太慢」。
      const message = err instanceof Error ? err.message : String(err);
      if (firstFrameScope && /超时/.test(message)) {
        const scale = (() => { try { return `${(fs.statSync(run.input.file).size / 1_048_576).toFixed(1)} MB 历史`; } catch { return ''; } })();
        (err as Error).message = `${message}（会话较大时首次加载可能需要数分钟${scale ? `，本次针对 ${scale}` : ''}；可再次点击该会话重试）`;
      }
      this.close(key); throw err;
    }
  }
  /** 周期哨兵：只在有活动 run 时启动一次，进程级共享，无 run 时空转成本可忽略。 */
  private async verifyStuckRun(run: Running) {
    const { key, generation } = run.view;
    const eventsAtCheck = run.eventCount;
    run.verifying = true;
    try {
      const state = await run.client.request('get_state', {}, 10_000).catch(() => null);
      if (!state) return; // pi 暂不可达：维持现状，下个窗口再试。
      // 等待期间来过任何事件（真活动）或 run 已被关闭/重连/进入停止流程 → 放弃本次结论。
      if (run.eventCount !== eventsAtCheck) return;
      if (this.active.get(key) !== run || run.view.generation !== generation) return;
      if (run.view.status !== 'running' || run.stopUnconfirmed) return;
      if (state.isStreaming || state.isCompacting || (Number(state.pendingMessageCount) || 0) > 0) {
        run.lastEventAt = Date.now();
        return;
      }
      this.forceSettle(run);
    } finally {
      run.verifying = false;
    }
  }
  /** 结算事件丢失时的就地收尾：与 agent_settled 的非中间态分支同语义（队列还原、计时收口、
   *  上下文刷新、挂起切换下发、续发派发），endedAt 尽量取转写末条真实时间而非纠正时刻，
   *  计时条停在与真实完成一致的用时上。 */
  private forceSettle(run: Running) {
    const key = run.view.key;
    if (this.active.get(key) !== run || run.view.status !== 'running') return;
    // 结算丢失同样打击重试链：组状态机只认 agent_settled，不补发就永远停在
    // phase='running'（横幅永续"等待模型响应"）。按 pi 已空闲的事实补发合成结算，
    // 让它按 lastOutcome 走完（completed/failed/exhausted→waiting）。若判为中间态
    // （排下了下一组退避），任务未结束：保持 running，只刷新静默起点与横幅。
    if (run.retry.event({ type: 'agent_settled', source: 'desktop-force-settle' })) {
      run.lastEventAt = Date.now();
      return;
    }
    let endedAt = Date.now();
    try {
      const last = this.index.history(key).branch.at(-1);
      const ts = last?.timestamp ? Date.parse(last.timestamp) : NaN;
      if (Number.isFinite(ts) && ts > (run.view.timing?.startedAt ?? 0) && ts <= endedAt) endedAt = ts;
    } catch { /* 历史不可读时退回当前时刻。 */ }
    if (run.view.timing && run.view.timing.endedAt === undefined) run.view.timing = { ...run.view.timing, endedAt };
    run.view.queue = [...run.deferredQueue]; run.view.pending = run.deferredQueue.length; run.queueImages = [];
    run.view.status = 'idle';
    this.refreshContextUsage(run);
    void this.flushPendingSwitches(key);
    if (run.view.retryGroup?.phase === 'completed') this.dispatchDeferred(run);
    this.emit({ type: 'run', run: { ...run.view } });
  }
  private onEvent(run: Running, event: Record<string, any>) {
    if (this.active.get(run.view.key) !== run) return;
    run.eventCount++; run.lastEventAt = Date.now();
    const { key, generation } = run.view;
    if (event.type === 'extension_ui_request') {
      const req = event as unknown as PiUiRequest;
      if (req.method === 'input' && req.title === 'desktop-automation') {
        // desktop_schedule 工具的调度请求：主进程程序化应答，不进对话框 UI。
        if (run.view.status === 'stopping') { run.client.send({ type: 'extension_ui_response', id: req.id, cancelled: true }); return; }
        const result = runAutomationBridge(this.automations, { cwd: run.input.cwd, permission: run.input.permission }, String(req.placeholder ?? ''));
        run.client.send({ type: 'extension_ui_response', id: req.id, value: JSON.stringify(result) });
        return;
      }
      if (req.method === 'setStatus' && req.statusKey === 'desktop-policy' && req.statusText) run.policyReady = true;
      if (req.method === 'setStatus' && req.statusKey === 'desktop-retry-ready' && req.statusText === generation) { run.retryReady = true; return; }
      if (req.method === 'setStatus' && req.statusKey === 'desktop-retry-settled') {
        try {
          const result = JSON.parse(String(req.statusText ?? ''));
          if (result.generation === generation && result.token === run.settlement?.token) {
            this.clearSettlement(run);
            this.onEvent(run, { type: 'agent_settled', source: 'desktop-wait-for-idle' });
          }
        } catch { /* Ignore malformed/stale bridge notifications. */ }
        return;
      }
      if (run.view.status === 'stopping' && ['select', 'confirm', 'input', 'editor'].includes(req.method)) { run.client.send({ type: 'extension_ui_response', id: req.id, cancelled: true }); return; }
      if (['select', 'confirm', 'input', 'editor'].includes(req.method)) {
        const timer = typeof req.timeout === 'number' && Number.isFinite(req.timeout) && req.timeout > 0 ? setTimeout(() => { run.dialogs.delete(req.id); this.emit({ type: 'rpc', key, generation, event: { type: 'ui-expired', id: req.id } }); }, Math.max(0, req.timeout)) : undefined;
        run.dialogs.set(req.id, { timer, method: req.method, request: req });
      }
      this.emit({ type: 'ui', key, generation, request: req }); return;
    }
    if (event.type === 'extension_error' && run.settlement && event.extensionPath === `command:desktop-retry-${generation}-settle`) {
      this.clearSettlement(run);
      run.retryUncertain = true;
      run.retry.fail(event.error || '运行时确认空闲失败（扩展报错），已暂停自动续接；请重新发送任务以恢复。');
    }
    if (event.type === 'extension_error' && run.retry.recovering &&
      (event.extensionPath === `command:desktop-retry-${generation}` || event.event === 'send_message')) {
      run.retry.fail(event.error || 'Desktop continuation failed');
    }
    if (['agent_start', 'message_start', 'auto_retry_start', 'agent_settled'].includes(event.type)) ++run.activity;
    if (event.type === 'agent_start' || event.type === 'agent_settled') this.clearSettlement(run);
    if (event.type === 'agent_settled') run.retryUncertain = false;
    const intermediateSettlement = run.retry.event(event);
    if ((event.type === 'auto_retry_end' && run.retry.needsSettlement)
      || (event.type === 'agent_end' && event.willRetry === false && run.retry.tracking)) this.ensureSettlement(run);
    if (event.type === 'agent_start') run.retryEntryId = undefined;
    if ((event.type === 'agent_start' || event.type === 'auto_retry_start' || event.type === 'compaction_start') && run.view.status !== 'stopping') {
      if (!run.view.timing || run.view.timing.endedAt !== undefined) run.view.timing = { startedAt: Date.now() };
      run.view.status = 'running';
      run.view.planReady = false;
    }
    // 压缩状态贯通到渲染层：过程列表据此显示「正在压缩上下文」。
    if (event.type === 'compaction_start') run.view.compacting = true;
    if (event.type === 'compaction_end') {
      run.view.compacting = false;
      // 压缩后 tokens 直接取 result.estimatedTokensAfter（与 tokensBefore 同一投影估算口径；
      // 留痕时 getContextUsage 为 null，stats 轮询拿不到）。失败/中止压缩 result 为 undefined，
      // 不发记录（desktop-policy 也没写留痕，无锚点可匹配）。at/contextWindow 取刚落盘的
      // 留痕 entry（session_compact 扩展先于 compaction_end await 完成落盘）。
      if (event.result) {
        try {
          const entry = [...this.index.history(key).branch].reverse().find((e: any) => e.customType === 'desktop-compaction');
          const tokensAfter = Number(event.result.estimatedTokensAfter);
          if (!(tokensAfter > 0)) return; // 字段缺失/非法时 fail closed：留痕退化为「压缩前」口径
          this.emit({
            type: 'compaction-record', key, generation,
            at: Number((entry as any)?.data?.at) || Date.now(),
            tokensAfter,
            contextWindow: Number((entry as any)?.data?.contextWindow) || 0,
          });
        } catch { /* 会话文件不可读时放弃回填，留痕退化为「压缩前」口径（fail closed） */ }
      }
    }
    if (event.type === 'agent_settled') {
      this.clearDialogs(run);
      if (!run.stopUnconfirmed) {
        run.view.queue = [...run.deferredQueue]; run.view.pending = run.deferredQueue.length; run.queueImages = [];
      }
      if (intermediateSettlement) {
        run.view.status = 'running';
        if (!run.retryEntryId) {
          try {
            const entry = [...this.index.history(key).branch].reverse().find(e => e.type === 'message' || e.type === 'custom_message');
            if (entry?.message?.role === 'assistant' && entry.message.stopReason === 'error') run.retryEntryId = entry.id;
          } catch { /* The timer fails closed if no persisted failed entry is available. */ }
        }
      } else {
        if (run.view.timing) run.view.timing = { ...run.view.timing, endedAt: Date.now() };
        if (run.view.status !== 'stopping' && !run.stopUnconfirmed) run.view.status = 'idle';
        this.refreshContextUsage(run);
        void this.flushPendingSwitches(key);
        if (run.view.retryGroup?.phase === 'completed') this.dispatchDeferred(run);
      }
    }
    // 一次模型调用刚结束、下一次尚未开始：挂起的模型/思考切换在这里下发，并顺带刷新上下文占用。
    if (event.type === 'message_end' && event.message?.role === 'assistant' && event.message?.stopReason !== 'error' && event.message?.stopReason !== 'aborted') { void this.flushPendingSwitches(key); this.refreshContextUsage(run); }
    if (event.type === 'message_end' && event.message?.role === 'assistant' && event.message?.stopReason !== 'error' && event.message?.stopReason !== 'aborted' && event.message?.content?.some((c: any) => c.type === 'text' && c.text?.trim()) && run.view.accessMode === 'plan') run.view.planReady = true;
    if (event.type === 'queue_update' && !run.stopUnconfirmed) {
      const prev = (run.view.queue ?? []).slice(0, (run.view.queue?.length ?? 0) - run.deferredQueue.length);
      const usedPrev = new Set<number>(), usedStaged = new Set<number>();
      // 先清掉过期暂存（从未被任何 queue_update 确认的陈旧登记），防止漏配给后来的同文项。
      const now = Date.now();
      run.queueImages = run.queueImages.filter(s => now - s.at < QUEUE_IMAGE_STAGE_TTL);
      run.view.queue = (['steering','followUp'] as const).flatMap(kind => (Array.isArray(event[kind]) ? event[kind] : []).map((item: any) => {
        const text = typeof item === 'string' ? item : String(item.text ?? item.message ?? '');
        const behavior = kind === 'steering' ? 'steer' as const : 'followUp' as const;
        // pi 的 queue_update 只回文本。图片按 文本+behavior+出现次序 接回：先在旧视图项里
        // 续接已关联的图（重复文本按第几次出现一一对应），没有再消费 prompt 时的暂存登记；
        // 都不命中保持纯文本——pi 改写过的文本安全落空，绝不把图错配给文本不同的排队项。
        let images: PiImage[] | undefined;
        const pi = prev.findIndex((q, i) => !usedPrev.has(i) && !!q.images?.length && q.text === text && q.behavior === behavior);
        if (pi >= 0) {
          usedPrev.add(pi); images = prev[pi].images;
          if (prev[pi].pendingSync) {
            // 乐观入队项的图在暂存池里还有一份成双登记，一并消费，避免重复配给后到的同文项。
            const si = run.queueImages.findIndex((s, i) => !usedStaged.has(i) && s.text === text && s.behavior === behavior);
            if (si >= 0) usedStaged.add(si);
          }
        } else {
          const si = run.queueImages.findIndex((s, i) => !usedStaged.has(i) && s.text === text && s.behavior === behavior);
          if (si >= 0) { usedStaged.add(si); images = run.queueImages[si].images; }
        }
        return images?.length ? { text, behavior, images } : { text, behavior };
      }));
      if (usedStaged.size) run.queueImages = run.queueImages.filter((_, i) => !usedStaged.has(i));
      run.view.queue.push(...run.deferredQueue);
      run.view.pending = run.view.queue.length;
    }
    // Event-level subagent persistence: works for ANY subagent implementation
    // (official, npm pi-subagents, custom) by observing RPC events, not extension internals.
    if (['tool_execution_start', 'tool_execution_update', 'tool_execution_end'].includes(event.type) && event.toolName === 'subagent') {
      persistSubagentEvent(this.env.agentDir, key, String(event.toolCallId ?? ''), event);
    }
    // Preserve the CLI boundary for diagnostics without advertising a final Desktop
    // settlement to automation/notifications while an outer retry is pending.
    this.emit({ type: 'rpc', key, generation, event: intermediateSettlement ? { type: 'desktop_retry_group_wait', retryGroup: run.view.retryGroup } : event });
    // message_update / tool_execution_update 逐 delta 到达（每秒几十个），上面的分支
    // 不会在它们上改 view；逐条重发完整 run 视图只会让渲染层每秒白渲染几十次。
    if (event.type !== 'message_update' && event.type !== 'tool_execution_update') this.emit({ type: 'run', run: { ...run.view } });
  }
  private clearSettlement(run: Running) {
    if (run.settlement) clearTimeout(run.settlement.timer);
    run.settlement = undefined;
  }
  private ensureSettlement(run: Running) {
    if (run.settlement) return;
    const token = randomUUID(), epoch = run.stopEpoch;
    const current = () => this.active.get(run.view.key) === run && run.stopEpoch === epoch && run.settlement?.token === token;
    const fail = (error: unknown) => {
      if (!current()) return;
      this.clearSettlement(run);
      run.retryUncertain = true;
      run.retry.fail(error);
    };
    // Native settlement normally arrives in the same event drain. Only ask the
    // command bridge if it did not; never infer settlement from agent_end/state.
    const timer = setTimeout(() => {
      if (!current()) return;
      if (!run.retryReady) { fail(new Error('运行时缺少安全空闲确认扩展，无法自动续接；请重新发送任务以恢复。')); return; }
      // 一次回执丢失不等于运行时异常：token 幂等（回执按 token 匹配），同一确认命令
      // 最多探测 3 次（10s RPC 超时 + 5s 间隔，总窗口约 45s），期间运行时恢复空闲即
      // 正常续接；仍无回执才降级为手动恢复。进程死亡由 current() 收敛。
      let attempts = 0;
      const probe = () => {
        if (!current() || run.view.status === 'stopping') return;
        attempts++;
        const next = () => {
          if (!current()) return;
          if (attempts >= 3) { fail(new Error('多次确认运行时空闲失败，已暂停自动续接；请重新发送任务以恢复。')); return; }
          run.settlement!.timer = setTimeout(probe, 5_000);
          run.settlement!.timer.unref?.();
        };
        void run.client.request('prompt', { message: `/desktop-retry-${run.view.generation}-settle ${JSON.stringify({ generation: run.view.generation, sessionFile: run.input.file, token })}` }, 10_000).then(() => {
          // RPC 完成但尚未见到 desktop-retry-settled 回执：确认可能仍在路上，间隔复查。
          if (current()) next();
        }).catch(next);
      };
      probe();
    }, 250);
    timer.unref?.();
    run.settlement = { token, timer };
  }
  private async continueRetryGroup(run: Running) {
    const { key, generation } = run.view;
    const epoch = run.stopEpoch;
    const failedEntryId = run.retryEntryId;
    run.retryEntryId = undefined;
    const current = () => this.active.get(key) === run && run.stopEpoch === epoch && run.view.status !== 'stopping';
    if (!current()) return;
    if (!run.retryReady) throw new Error('Desktop 安全续接扩展未就绪，未自动重放任务。');
    // Read the persisted active branch, not the last UI message or abandoned leaves.
    const history = this.index.history(key);
    const entry = [...history.branch].reverse().find(e => e.type === 'message' || e.type === 'custom_message');
    if (!failedEntryId || entry?.id !== failedEntryId || entry.message?.role !== 'assistant' || entry.message.stopReason !== 'error') throw new Error('重试上下文已变化，未自动重放任务。');
    const state = await run.client.request('get_state', {}, 5_000);
    if (!current()) return;
    if (state?.isStreaming || state?.isCompacting || state?.pendingMessageCount > 0) throw new Error('pi 尚未完全空闲，未重复分发重试。');
    if (!current()) return;
    const stateAtDispatch = run.retry.state;
    try {
      await run.client.request('prompt', { message: `/desktop-retry-${generation} ${JSON.stringify({ generation, sessionFile: run.input.file, entryId: entry.id, group: run.view.retryGroup!.group })}` }, 10_000);
    } catch (error) {
      if (!current()) return;
      // Observable progress is stronger evidence than an old/missing ACK. Do not
      // cancel a later group's timer (or a fresh task) because this ACK was late.
      if (run.retry.state !== stateAtDispatch) return;
      run.retryUncertain = true;
      throw error; // stop outer dispatch, but retain a cancellable running view
    }
  }
  private dispatchDeferred(run: Running, explicit = false) {
    if (!run.deferredQueue.length || run.view.status === 'stopping' || run.stopUnconfirmed || run.retryUncertain) return;
    const epoch = run.stopEpoch;
    const retryState = run.retry.state;
    // Run after the current settled notification has been delivered; never dispatch
    // inside the callback that consumes it, and never send an item twice on timeout.
    queueMicrotask(() => {
      if (this.active.get(run.view.key) !== run || run.stopEpoch !== epoch || run.retry.state !== retryState || run.view.status !== 'idle' || (!explicit && run.view.retryGroup?.phase !== 'completed')) return;
      const item = run.deferredQueue.shift();
      if (!item) return;
      run.view.queue = [...run.deferredQueue]; run.view.pending = run.deferredQueue.length;
      void this.prompt(run.view.key, item.text, item.behavior, item.images, true).catch(error => {
        if (this.active.get(run.view.key) !== run || run.stopEpoch !== epoch) return;
        // Acceptance may be unknown. Surface the error, never put the sent item back.
        run.view.error = String(error instanceof Error ? error.message : error);
        this.emit({ type: 'run', run: { ...run.view } });
      });
    });
  }
  async prompt(key: string, text: string, behavior: 'steer' | 'followUp', images?: import('../../shared/composer').PiImage[], dispatchDeferred = false) {
    if (!text.trim() || text.length > 200_000) throw new Error('输入为空或超过 200000 字符');
    const run = this.get(key);
    if (!['idle', 'running'].includes(run.view.status) || run.stopUnconfirmed || run.retryUncertain) throw new Error('当前会话暂不能发送；请先停止确认执行状态');
    if (run.input.permission === 'plan' && text.trimStart().startsWith('/')) throw new Error('计划模式不运行斜杠命令，请使用普通输入研究项目。');
    if (images !== undefined && !Array.isArray(images)) throw new Error('图片格式无效');
    if (images?.length) {
      if (!Array.isArray(images) || images.length > 10 || images.some(i => !i || i.type !== 'image' || !['image/png','image/jpeg','image/webp','image/gif'].includes(i.mimeType) || typeof i.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(i.data)) || images.reduce((n,i)=>n+i.data.length,0) > 10*1024*1024) throw new Error('图片格式无效或总大小超过 10 MiB，请减少图片。');
      if (run.view.model?.input && !run.view.model.input.includes('image')) throw new Error('当前模型不支持图片，请选择支持图片的模型。');
    }
    if (!dispatchDeferred && run.view.status === 'idle' && run.deferredQueue.length > 0) throw new Error('上次任务未恢复，追问已保留；请先停止取回，或在队列中选择立即发送。');
    if (!dispatchDeferred && (run.retry.holding || run.deferredQueue.length > 0)) {
      const item = { text, behavior, ...(images?.length ? { images } : {}) };
      run.deferredQueue.push(item);
      run.view.queue = [...(run.view.queue ?? []), item]; run.view.pending = run.view.queue.length;
      this.emit({ type: 'run', run: { ...run.view } });
      return;
    }
    const startsGroup = run.view.status === 'idle';
    if (startsGroup) { ++run.promptSequence; run.retryEntryId = undefined; run.retry.begin(); run.view.error = undefined; }
    const promptEpoch = run.stopEpoch, promptSequence = run.promptSequence, activity = run.activity;
    // 运行中发送 = 排队：先把图片登记进 sidecar（pi 的 queue_update 只回文本，权威队列到达后
    // 按 文本+behavior+出现次序 接回），并乐观进入 view.queue，让队列管理（撤回/删除/立即）
    // 在 queue_update 到达前就能按索引命中。RPC 失败则暂存与乐观项一并撤回，不留残渣。
    const queued = run.view.status === 'running';
    let staged: StagedQueueImage | undefined;
    let optimisticEntry: NonNullable<PiRun['queue']>[number] | undefined;
    if (queued) {
      if (images?.length) { staged = { text, behavior, images, at: Date.now() }; run.queueImages.push(staged); }
      optimisticEntry = { text, behavior, ...(images?.length ? { images } : {}), pendingSync: true };
      run.view.queue = [...(run.view.queue ?? []), optimisticEntry];
      run.view.pending = run.view.queue.length;
      this.emit({ type: 'run', run: { ...run.view } });
    }
    try {
      await run.client.request('prompt', { message: text, streamingBehavior: behavior, ...(images?.length ? {images} : {}) }, 300_000);
    } catch (error) {
      if (this.active.get(key) !== run || run.stopEpoch !== promptEpoch) throw error;
      // Some runtimes/commands defer prompt's response; a transport timeout is
      // not a task deadline. Once events prove acceptance, do not reject the UI's
      // send or cancel this (possibly now >5-minute) retry budget.
      if (startsGroup && (run.activity !== activity || run.promptSequence !== promptSequence)) return;
      if (startsGroup && /超时|timeout|timed out/i.test(String(error))) {
        run.view.error = '发送确认超时，执行状态未知；未自动重发，请停止后确认。';
        run.retryUncertain = true; run.view.status = 'running';
        this.emit({ type: 'run', run: { ...run.view } });
        return;
      }
      if (startsGroup) run.retry.cancel();
      if (staged) run.queueImages = run.queueImages.filter(s => s !== staged);
      if (optimisticEntry && run.view.queue?.includes(optimisticEntry)) {
        run.view.queue = run.view.queue.filter(q => q !== optimisticEntry);
        run.view.pending = run.view.queue.length;
        this.emit({ type: 'run', run: { ...run.view } });
      }
      throw error;
    }
  }
  /**
   * 编辑已发送消息的前半步：pi 的 fork RPC 把会话树截断回该条目（被改写轮之后的
   * 分支仍留在文件里，TUI /tree 可回访）。截断成功后渲染层重发编辑文本，等价
   * ZCode 的「重置对话并发送」。运行中/有待审批时拒绝，与 refresh 同一口径。
   */
  async forkTo(key: string, entryId: string): Promise<string> {
    if (typeof entryId !== 'string' || !entryId) throw new Error('消息条目无效');
    const run = this.get(key);
    if (['starting', 'running', 'stopping'].includes(run.view.status) || run.view.pending > 0) throw new Error('请先停止当前任务再编辑历史消息');
    if (this.hasPendingDialogs(key)) throw new Error('等待交互完成后再编辑');
    const result = await run.client.request('fork', { entryId }, 30_000) as { text?: unknown; cancelled?: unknown } | undefined;
    if (result?.cancelled) throw new Error('回退已取消');
    // pi fork 后把后续对话写进新 session 文件（旧文件成为只读快照）。记录延续关系：
    // 点击旧条目时重定向到链尾（历史完整），侧栏合并为一条，避免出现同名新会话。
    try {
      const state = await run.client.request('get_state', {}, 10_000) as { sessionFile?: string } | undefined;
      const next = state?.sessionFile;
      if (this.dataDir && typeof next === 'string' && next && canonical(next) !== canonical(run.input.file)) {
        saveContinuations(this.dataDir, recordContinuation(loadContinuations(this.dataDir), run.input.file, next));
        // 二次编辑重发必须喂链尾（否则 record 会用过期链头产生断链映射）。
        run.input.file = canonical(next);
        this.onContinuation?.(key, fileKey(run.input.file));
      }
    } catch { /* 记录失败不影响 fork 本身；下次编辑重发会再记 */ }
    void this.refreshContextUsage(run);
    this.emit({ type: 'run', run: { ...run.view } });
    return typeof result?.text === 'string' ? result.text : '';
  }
  async stop(key: string) {
    const run = this.get(key);
    const stopEpoch = ++run.stopEpoch;
    this.clearSettlement(run);
    run.retry.cancel(); run.retryEntryId = undefined; // cancel timer before the first RPC/await
    run.stopUnconfirmed = true;
    const deferred = [...run.deferredQueue];
    const snapshot = run.stopQueueSnapshot ?? [...(run.view.queue ?? [])];
    run.view.status = 'stopping'; this.emit({ type: 'run', run: { ...run.view } });
    // Resolve dialogs first; extension commands can otherwise block the RPC handler.
    for (const id of run.dialogs.keys()) run.client.send({ type: 'extension_ui_response', id, cancelled: true });
    this.clearDialogs(run);
    // Send clear_queue and abort in wire order without waiting for clear_queue's
    // response: a stalled request must not postpone cancelling the model/retry.
    const cleared = run.client.request('clear_queue');
    const aborted = run.client.request('abort', {}, 30_000);
    const [clearResult, abortResult] = await Promise.allSettled([cleared, aborted]);
    if (this.active.get(key) !== run || run.stopEpoch !== stopEpoch) {
      // 被更新的一次 stop（或已退出的 run）顶替：结果由后者接管，静默退出。
      // 抛错只会把良性的重复点击变成红色报错（用户在长工具执行期间重复点停止是常态）。
      return { steering: [], followUp: [] };
    }
    if (clearResult.status === 'rejected' || abortResult.status === 'rejected') {
      run.stopQueueSnapshot = snapshot;
      // Keep host-owned inputs until BOTH operations succeed. If clear succeeded,
      // its returned remote inputs are now host-owned too (retain image sidecars).
      if (clearResult.status === 'fulfilled') {
        const remote = clearResult.value ?? { steering: [], followUp: [] };
        const available = snapshot.slice(0, snapshot.length - deferred.length);
        run.deferredQueue = (['steering', 'followUp'] as const).flatMap(kind => (remote[kind] ?? []).map((text: string) => {
          const behavior = kind === 'steering' ? 'steer' as const : 'followUp' as const;
          const at = available.findIndex(q => q.text === text && q.behavior === behavior);
          return at >= 0 ? available.splice(at, 1)[0] : { text, behavior };
        })).concat(deferred);
        run.view.queue = [...run.deferredQueue];
      } else run.view.queue = snapshot;
      run.view.pending = run.view.queue!.length;
      run.view.status = 'running'; // Stop remains available; sends blocked until confirmed.
      run.view.error = '停止未确认，追问已保留；请再次停止。';
      this.emit({ type: 'run', run: { ...run.view } });
      throw clearResult.status === 'rejected' ? clearResult.reason : (abortResult as PromiseRejectedResult).reason;
    }
    const queue = clearResult.value || { steering: [], followUp: [] };
    run.deferredQueue = []; run.stopUnconfirmed = false; run.retryUncertain = false;
    for (const item of deferred) (queue[item.behavior === 'steer' ? 'steering' : 'followUp'] ??= []).push(item.text);
    // A rejected clear_queue may already have cleared its remote queue. On a
    // later successful Stop, reconcile retained text by occurrence (not Set),
    // without duplicating items still returned by the runtime. Never auto-send it.
    if (run.stopQueueSnapshot) {
      for (const [kind, behavior] of [['steering', 'steer'], ['followUp', 'followUp']] as const) {
        const unmatched = [...(queue[kind] ?? [])];
        for (const item of run.stopQueueSnapshot.filter(q => q.behavior === behavior)) {
          const at = unmatched.indexOf(item.text);
          if (at >= 0) unmatched.splice(at, 1);
          else (queue[kind] ??= []).push(item.text);
        }
      }
    }
    run.stopQueueSnapshot = undefined;
    run.queueImages = [];
    if (run.view.timing && run.view.timing.endedAt === undefined) run.view.timing = { ...run.view.timing, endedAt: Date.now() };
    run.view.status = 'idle'; run.view.pending = 0; run.view.queue = []; this.emit({ type: 'run', run: { ...run.view } });
    return queue || { steering: [], followUp: [] };
  }
  /**
   * 手动压缩上下文：pi RPC 有专用 compact 命令，但 get_commands 不含内置斜杠命令，
   * 所以 Desktop 拦截 /compact 路由到这里（TUI interactive-mode 的同款能力）。
   * 压缩只发 compaction_start/end、不发 agent_settled，完成后需在此复位状态。
   */
  /** 按需重拉斜杠命令列表：补全面板发现列表为空时可调用；有新增则更新并广播。 */
  /** 重新拉取可用模型/思考等级：供应商列表更新后，无需断开重连即可刷新会话内模型菜单。 */
  async refreshModels(key: string): Promise<number> {
    const run = this.get(key);
    if (run.view.status === 'error') return run.view.models.length;
    const models = await run.client.request('get_available_models', {}, 30_000);
    const thinking = await run.client.request('get_available_thinking_levels', {}, 15_000).catch(() => ({ levels: [] }));
    if (this.active.get(key) !== run) return (models?.models || []).length; // 刷新期间会话已关闭/重连，废弃本次结果，避免僵尸 run 事件
    const view = run.view;
    const cleanModel = (m: any) => ({ id: String(m.id), name: String(m.name || m.id), provider: String(m.provider), reasoning: !!m.reasoning, input: Array.isArray(m.input) ? m.input : undefined });
    view.models = (models?.models || []).map(cleanModel);
    view.thinkingLevels = thinking?.levels ?? view.thinkingLevels;
    const current = view.model;
    if (current && !view.models.some(m => m.provider === current.provider && m.id === current.id)) {
      // 当前选中的模型已从目录移除：清掉选择，避免发送时命中不存在的模型。
      view.model = undefined;
    }
    this.emit({ type: 'run', run: { ...view } });
    return view.models.length;
  }

  async refreshCommands(key: string): Promise<number> {
    const run = this.get(key);
    if (run.view.status === 'error') return run.view.commands.length;
    const result = await run.client.request('get_commands', {}, 15_000);
    const view = run.view;
    const list = ((result?.commands || []) as any[]).filter((c: any) => !String(c.name).startsWith('desktop-retry-'))
      .map((c: any) => ({ name: String(c.name), description: c.description, source: c.source, path: c.path ?? String(c.sourceInfo?.path ?? '') }));
    if (list.length > view.commands.length) {
      view.commands = list;
      this.emit({ type: 'run', run: { ...view } });
    }
    return view.commands.length;
  }

  /** 内置 /reload（pi CLI interactive-mode 同款）：RPC 协议没有 reload 命令，Desktop 等价实现 =
   *  重启 pi 并重连同一会话。资源（扩展/skills/prompts/主题/上下文文件）全量重载，
   *  历史经 session 文件完整保留。仅 idle 允许；旧进程的 closed 事件因 active 已换新 run 而静默。 */
  async reloadSession(key: string) {
    const run = this.active.get(key);
    if (!run) throw new Error('会话未连接；请从侧栏重新打开后再重载。');
    if (run.view.status !== 'idle') throw new Error('请等待当前任务完成后再重载会话。');
    const input = { ...run.input };
    this.close(key);
    return this.launch(input);
  }

  async compact(key: string, customInstructions?: string) {
    const run = this.get(key);
    if (run.view.status !== 'idle') throw new Error('请在任务空闲时压缩上下文');
    if (run.dialogs.size) throw new Error('请先处理待确认操作，再压缩上下文。');
    // 压缩是对整段上下文的模型调用，耗时不可预测，超时放宽到 3 分钟。
    const result = await run.client.request('compact', customInstructions ? { customInstructions } : {}, 180_000);
    this.refreshContextUsage(run);
    // compaction 期间 compaction_start 已把状态置为 running（TS 看不到事件改写，故宽化比较）；排队中的消息不动。
    const statusAfter = run.view.status as string;
    if (statusAfter === 'running' && !run.view.pending && !run.view.queue?.length) {
      run.view.status = 'idle';
      if (run.view.timing && run.view.timing.endedAt === undefined) run.view.timing = { ...run.view.timing, endedAt: Date.now() };
      this.emit({ type: 'run', run: { ...run.view } });
    }
    return result;
  }
  /**
   * Mutate the follow-up queue of a running session. pi only exposes
   * clear_queue, so editing one item = clear + re-queue the rest (and for
   * 'now', steer the chosen item into the current run immediately).
   */
  async queueEdit(key: string, op: import('../../shared/pi').PiQueueOp) {
    const run = this.get(key);
    if (run.view.status !== 'running' && run.view.status !== 'starting' && !(run.view.status === 'idle' && run.deferredQueue.length)) throw new Error('仅在任务运行中可以管理追问队列');
    if (run.retry.holding || run.deferredQueue.length) {
      const remoteCount = (run.view.queue?.length ?? 0) - run.deferredQueue.length;
      const index = op.index - remoteCount;
      if (!Number.isInteger(index) || index < 0 || index >= run.deferredQueue.length) throw new Error('恢复期间仅可管理 Desktop 暂存的追问');
      if (op.type === 'edit') {
        const text = String(op.text ?? '').trim();
        if (!text || text.length > 200_000) throw new Error('内容为空或超过 200000 字符');
        run.deferredQueue[index] = { ...run.deferredQueue[index], text };
      } else {
        const [item] = run.deferredQueue.splice(index, 1);
        if (op.type === 'now') run.deferredQueue.unshift({ ...item, behavior: 'steer' });
      }
      run.view.queue = [...(run.view.queue ?? []).slice(0, remoteCount), ...run.deferredQueue];
      run.view.pending = run.view.queue.length;
      this.emit({ type: 'run', run: { ...run.view } });
      if (op.type === 'now' && run.view.status === 'idle') this.dispatchDeferred(run, true);
      return;
    }
    const editEpoch = run.stopEpoch;
    const items = (run.view.queue ?? []).map((item) => ({ ...item }));
    if (!Number.isInteger(op.index) || op.index < 0 || op.index >= items.length) throw new Error('队列项不存在');
    if (op.type === 'edit') {
      const text = String(op.text ?? '').trim();
      if (!text || text.length > 200_000) throw new Error('内容为空或超过 200000 字符');
      items[op.index].text = text;
    }
    // 'edit' keeps the item in place; 'remove' drops it; 'now' steers it into the run.
    const target = op.type === 'edit' ? undefined : items.splice(op.index, 1)[0];
    // clear + 重排会推翻现有队列：旧暂存登记一并作废，剩余项的图在重发时重新暂存，
    // 避免旧登记漏给后来同文本的纯文本排队项。
    run.queueImages = [];
    await run.client.request('clear_queue');
    if (this.active.get(key) !== run || run.stopEpoch !== editEpoch) return;
    // pi 的 prompt 响应依赖 preflight 回调，回合边界期可能长时间不回（消息其实
    // 已进入 agent 队列）——不能同步等待，否则「立即」在 UI 上像没反应。
    // 重发的 prompt body 必须携带图片附件（pi 自己不会记住 queue_update 之外的图），
    // 并重新暂存，让随后的 queue_update 能把图接回视图。
    const fire = (text: string, behavior: 'steer' | 'followUp', images?: PiImage[]) => {
      let staged: StagedQueueImage | undefined;
      if (images?.length) { staged = { text, behavior, images, at: Date.now() }; run.queueImages.push(staged); }
      void run.client.request('prompt', { message: text, streamingBehavior: behavior, ...(images?.length ? { images } : {}) }, 30_000)
        .catch(() => { if (staged) run.queueImages = run.queueImages.filter(s => s !== staged); });
    };
    if (op.type === 'now' && target) fire(target.text, 'steer', target.images ?? op.images);
    for (const item of items) fire(item.text, item.behavior, item.images);
  }
  async setAccessMode(key: string, mode: AccessMode): Promise<PiRun> {
    if (!isAccessMode(mode)) throw new Error('无效访问模式');
    const run = this.get(key);
    if (run.dialogs.size) throw new Error('请先处理待确认操作，再切换访问模式。');
    if (run.input.permission === mode && run.view.accessMode === mode) return { ...run.view };
    // Rewrite the control file; the policy extension picks it up on the next
    // tool call — including while a task is running. No restart needed.
    const modeFile = path.join(this.ownedRoot, `.mode-${key}`);
    fs.mkdirSync(this.ownedRoot, { recursive: true });
    fs.writeFileSync(modeFile, mode, 'utf8');
    const previous = run.view.accessMode ?? run.input.permission;
    run.input.permission = mode;
    run.view.accessMode = mode;
    if (mode === 'plan') run.view.executionMode = previous === 'plan' ? run.view.executionMode ?? 'ask' : previous;
    else if (previous === 'plan') run.view.executionMode = mode;
    this.emit({ type: 'run', run: { ...run.view } });
    return { ...run.view };
  }
  async model(key: string, provider: string, modelId: string) {
    const run = this.get(key);
    const model = run.view.models.find(m => m.provider === provider && m.id === modelId);
    if (!model) throw new Error('模型不在 pi 可用列表中');
    // 运行中不直接下发：pi 的 set_model 会立即改写状态（并顺带重置思考等级），
    // 挂起到下一次模型调用的边界（assistant message_end）再统一切换。
    if (run.view.status === 'running' || run.view.status === 'starting') {
      if (run.view.model?.provider === provider && run.view.model?.id === modelId) return { ...run.view };
      run.view.pendingModel = { provider, id: modelId };
      this.emit({ type: 'run', run: { ...run.view } });
      return { ...run.view };
    }
    if (run.view.status !== 'idle') throw new Error('请在空闲时切换模型');
    run.view.pendingModel = undefined;
    await this.applyModel(run, provider, modelId);
    return { ...run.view };
  }
  async thinking(key: string, level: ThinkingLevel) {
    const run = this.get(key);
    // 只校验等级名本身；能力钳制交给 pi（set_thinking_level 内部 clampThinkingLevel），
    // 实际生效值由 get_state 回读，绝不显示与运行不一致的等级。
    if (!THINKING_LEVELS.includes(level)) throw new Error('未知的思考等级。');
    if (run.view.status === 'running' || run.view.status === 'starting') {
      if (run.view.thinkingLevel === level) return { ...run.view };
      run.view.pendingThinking = level;
      this.emit({ type: 'run', run: { ...run.view } });
      return { ...run.view };
    }
    if (run.view.status !== 'idle') throw new Error('请在任务空闲时切换思考等级。');
    run.view.pendingThinking = undefined;
    await this.applyThinking(run, level);
    return { ...run.view };
  }
  private async applyModel(run: Running, provider: string, modelId: string) {
    const model = run.view.models.find(m => m.provider === provider && m.id === modelId);
    if (!model) throw new Error('模型不在 pi 可用列表中');
    await run.client.request('set_model', { provider, modelId }); run.view.model = model;
    const state = await run.client.request('get_state');
    run.view.thinkingLevel = state?.thinkingLevel ?? 'off';
    run.view.thinkingLevels = (await run.client.request('get_available_thinking_levels').catch(() => ({levels: []})))?.levels ?? [];
    this.emit({ type: 'run', run: { ...run.view } });
  }
  private async applyThinking(run: Running, level: ThinkingLevel) {
    if (!THINKING_LEVELS.includes(level)) throw new Error('未知的思考等级。');
    await run.client.request('set_thinking_level', {level});
    const state = await run.client.request('get_state');
    run.view.thinkingLevel = state.thinkingLevel;
    this.emit({type:'run',run:{...run.view}});
  }
  /**
   * Pending model/thinking switches taken while a task runs are pushed to pi at
   * the next boundary: an assistant message_end (one model call just finished,
   * the next one has not started) or agent_settled (task over, direct switch).
   */
  private async flushPendingSwitches(key: string) {
    const run = this.active.get(key);
    if (!run) return;
    const model = run.view.pendingModel, thinking = run.view.pendingThinking;
    if (!model && !thinking) return;
    run.view.pendingModel = undefined; run.view.pendingThinking = undefined;
    try {
      if (model) await this.applyModel(run, model.provider, model.id);
      if (thinking) await this.applyThinking(run, thinking);
    } catch (error) {
      run.view.error = String((error as Error).message || error);
      this.emit({ type: 'run', run: { ...run.view } });
    }
  }
  respond(key: string, generation: string, response: { id: string; value?: string; confirmed?: boolean; cancelled?: boolean }) {
    const run = this.get(key);
    if (run.view.generation !== generation || !run.dialogs.has(response.id)) throw new Error('交互请求已过期');
    clearTimeout(run.dialogs.get(response.id)?.timer); run.dialogs.delete(response.id);
    run.client.send({ type: 'extension_ui_response', id: response.id, ...(typeof response.value === 'string' ? { value: response.value } : {}), ...(typeof response.confirmed === 'boolean' ? { confirmed: response.confirmed } : {}), ...(typeof response.cancelled === 'boolean' ? { cancelled: response.cancelled } : {}) });
    // 多端同步：桌面端已本地移除卡片，远控页（可能多台）靠此事件同步消失。
    this.emit({ type: 'rpc', key, generation, event: { type: 'ui-resolved', id: response.id } });
  }
  private clearDialogs(run: Running) {
    for (const [id, d] of run.dialogs) {
      clearTimeout(d.timer);
      this.emit({type:'rpc',key:run.view.key,generation:run.view.generation,event:{type:'ui-expired',id}});
    }
    run.dialogs.clear();
  }
  close(key: string) { const run = this.active.get(key); if (!run) return; this.active.delete(key); ++run.stopEpoch; if (run.recheckTimer) { clearTimeout(run.recheckTimer); run.recheckTimer = undefined; } this.clearSettlement(run); run.retry.dispose(); run.deferredQueue = []; this.clearDialogs(run); run.client.close(); fs.rm(path.join(this.ownedRoot, `.mode-${key}`), () => undefined); this.emit({ type: 'closed', key, generation: run.view.generation }); }
  async refresh(key: string) { const run = this.get(key); if (run.view.status !== 'idle' || run.view.pending || run.dialogs.size) throw new Error('会话仍在运行或等待交互，请完成或停止后刷新。'); const input = run.input; const executionMode = run.view.executionMode; const timing = run.view.timing; this.close(key); await this.launch(input); const active = this.get(key); active.view.executionMode = executionMode; active.view.timing = timing; this.emit({ type: 'run', run: { ...active.view } }); return { ...active.view }; }
  /** connect 首帧预算：会话文件越大加载越久（实测 40MB/700 条含截图会话 >60s）。
   *  小会话保持 60s，大会话按 5s/MB 放宽（40MB→210s，上限 5 分钟）。 */
  private startupBudget(file: string): number {
    try {
      const bytes = fs.statSync(file).size;
      // 增量按整 MB 计：小会话（<10MB）一律 60s 基线，之后每 MB +5s，封顶 5 分钟。
      const mb = Math.floor(bytes / 1_048_576);
      if (mb < 10) return 60_000;
      return Math.min(300_000, 60_000 + (mb - 10) * 5_000);
    } catch { return 60_000; }
  }
  /** 周期哨兵：只在有活动 run 时启动一次，进程级共享，无 run 时空转成本可忽略。 */
  private ensureWatchdog() {
    if (this.watchdog) return;
    this.watchdog = setInterval(() => this.stuckScan(), STUCK_WATCHDOG_INTERVAL_MS);
    this.watchdog.unref?.();
  }
  /** 扫描当前活动 run：只有长时间无任何 pi 事件的 running 才值得向 pi 本体核实。
   *  重试链持有期（holding：等待续接/已进入续接）正常由 agent_settled 收口，但结算事件
   *  一样可能丢失（实测第 4/10 组模型已回、横幅永续"等待模型响应"）——用更宽的静默窗
   *  纳入巡逻（get_state 核实对真实在跑/等待期均无副作用）；结算桥进行中仍不打扰。
   *  普通轮次（group=1 phase=running）用基础阈值。 */
  private stuckScan() {
    const now = Date.now();
    for (const run of this.active.values()) {
      if (run.view.status !== 'running' || run.verifying) continue;
      if (run.stopUnconfirmed || run.retryUncertain || run.settlement) continue;
      if (run.dialogs.size > 0) continue;
      const silence = run.retry.holding ? RETRY_HOLDING_SILENCE_MS : STUCK_SILENCE_MS;
      if (now - run.lastEventAt < silence) continue;
      void this.verifyStuckRun(run);
    }
  }
  dispose() { for (const key of this.active.keys()) this.close(key); if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = undefined; } }
}
