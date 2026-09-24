import { THINKING_LEVELS, type ThinkingLevel } from '../../shared/composer';
import { isAccessMode, type AccessMode } from '../../shared/access-mode';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PiEnvironment, PiEvent, PiRun, PiUiRequest } from '../../shared/pi';
import { PiRpcClient } from './rpc-client';
import { SessionIndex, fileKey } from './session-index';
import { summarizeContext } from './context-details';
import { detectThirdPartySubagent, migrateOldSubagentExtension, persistSubagentEvent } from './official-subagent';
interface Running { policyReady: boolean; client: PiRpcClient; view: PiRun; input: { cwd: string; trustProject: boolean; permission: AccessMode; executionMode?: Exclude<AccessMode, 'plan'>; file: string; origin: string; systemPrompt?: string; tools?: string[]; model?: string }; dialogs: Map<string, { timer?: ReturnType<typeof setTimeout>; method: string; request: PiUiRequest }> }
export class PiBackend {
  private active = new Map<string, Running>();
  /** 记忆衔接：main 在 SettingsService 就绪后注入；每次 launch 现取最新开关与目录。 */
  memoryOptions: (() => { enabled: boolean; dir: string }) | undefined;
  constructor(private env: PiEnvironment, private index: SessionIndex, private ownedRoot: string, private policyPath: string, private emit: (e: PiEvent) => void) {}
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
      origin = fileKey(source.session.path);
      const attached = this.active.get(origin) ?? [...this.active.values()].find(r => r.input.origin === origin);
      if (attached) return attached.view;
    }
    if (this.active.size >= 6) throw new Error('最多同时连接 6 个会话，请先断开空闲会话。');
    fs.mkdirSync(this.ownedRoot, { recursive: true });
    this.ownedRoot = fs.realpathSync(this.ownedRoot);
    if (input.sourceKey) {
      const source = this.index.history(input.sourceKey);
      cwd = source.session.cwd;
      if (source.session.owned) {
        // Desktop 自建会话原地续聊；只有外部 CLI 会话才派生副本，
        // 否则每次断开后继续都会 fork 出一条新会话。
        file = source.session.path;
      } else {
        // 外部原件已有 Desktop 副本时，继续最近的那个副本，不再重复 fork。
        const child = this.index.scan().find(s => s.owned && s.parentSession === source.session.path);
        if (child) { const activeChild=this.active.get(child.key); if(activeChild)return activeChild.view; file = child.path; }
        else {
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
    const key = fileKey(input.file), generation = randomUUID();
    // The policy extension re-reads this file per tool call, so the access
    // mode can change mid-run without restarting the session process.
    const modeFile = path.join(this.ownedRoot, `.mode-${key}`);
    fs.mkdirSync(this.ownedRoot, { recursive: true });
    fs.writeFileSync(modeFile, input.permission, 'utf8');
    const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: this.env.agentDir, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_DESKTOP_PERMISSION: input.permission, PI_DESKTOP_MODE_FILE: modeFile, PI_DESKTOP_TRUST_PROJECT: input.trustProject ? '1' : '0' };
    delete env.ELECTRON_RUN_AS_NODE;
    // GUI applications may not inherit the same PATH as a terminal.
    env.PATH = [path.dirname(this.env.executable!), '/opt/homebrew/bin', '/usr/local/bin', env.PATH || ''].join(path.delimiter);
    // Desktop 自带的 ask_user_question 扩展（随 Desktop 默认加载；缺失不阻塞会话）。
    const askPath = path.join(path.dirname(this.policyPath), '..', 'desktop-ask', 'index.mjs');
    const askArgs = fs.existsSync(askPath) ? ['-e', askPath] : [];
    // 记忆衔接扩展：memoryAssist 开启时随会话装载，agent_end 后自动整理记忆。
    const memory = this.memoryOptions?.() ?? { enabled: false, dir: '' };
    const memoryPath = path.join(path.dirname(this.policyPath), '..', 'desktop-memory', 'index.mjs');
    const memoryArgs = memory.enabled && fs.existsSync(memoryPath) ? ['-e', memoryPath] : [];
    if (memory.enabled) {
      env.PI_DESKTOP_MEMORY = '1';
      if (memory.dir) env.PI_DESKTOP_MEMORY_DIR = memory.dir;
    }
    // Subagent fallback：仅在用户没有安装第三方 subagent 插件时加载。
    // 检测 agentDir/extensions/ + settings.json packages 里的 subagent 扩展。
    // 旧版 desktop-official-subagent 在 agentDir/extensions/ 里会和 npm 包冲突，
    // 迁移时自动删除旧目录，改用 -e 加载消除冲突。
    migrateOldSubagentExtension(this.env.agentDir);
    const subagentPath = path.join(path.dirname(this.policyPath), '..', 'desktop-subagent', 'index.mjs');
    const subagentArgs = fs.existsSync(subagentPath) && !detectThirdPartySubagent(this.env.agentDir).detected ? ['-e', subagentPath] : [];
    const args = [
      ...(this.env.launchArgs || []),
      '--mode', 'rpc',
      '--session', input.file,
      '--session-dir', this.ownedRoot,
      input.trustProject ? '--approve' : '--no-approve',
      '-e', this.policyPath,
      '-e', path.join(path.dirname(this.policyPath), 'mcp-bridge.mjs'),
      ...askArgs,
      ...memoryArgs,
      ...subagentArgs,
      ...(input.systemPrompt ? ['--append-system-prompt', input.systemPrompt] : []),
      ...(input.permission === 'plan'
        // 计划模式：只读工具 + ask_user_question（提问无副作用，正好用于澄清需求）+ 任务清单。
        ? ['--tools', [...(input.tools ?? ['read', 'grep', 'find', 'ls']).filter(t => ['read', 'grep', 'find', 'ls'].includes(t)), 'ask_user_question', 'desktop_update_plan'].join(',')]
        : input.tools ? ['--tools', input.tools.join(',')] : []),
      ...(input.model ? ['--model', input.model] : []),
    ];
    const client = new PiRpcClient(this.env.executable!, args, input.cwd, env);
    const view: PiRun = { accessMode: input.permission, executionMode: input.permission === 'plan' ? input.executionMode ?? 'ask' : input.permission, key, generation, cwd: input.cwd, file: input.file, status: 'starting', models: [], commands: [], pending: 0 };
    const run: Running = { policyReady: false, client, view, input, dialogs: new Map() };
    this.active.set(key, run); this.emit({ type: 'run', run: { ...view } });
    client.on('event', event => this.onEvent(run, event));
    client.on('closed', () => {
      if (this.active.get(key) !== run) return;
      this.active.delete(key);
      if (view.timing && view.timing.endedAt === undefined) view.timing = { ...view.timing, endedAt: Date.now() };
      view.status = 'error';
      const stderr = client.stderrDetail();
      view.error = `pi 进程已退出，请断开后重连。任务未自动重放。${stderr ? `\npi stderr：${stderr}` : ''}`;
      this.clearDialogs(run); this.emit({ type: 'run', run: { ...view } }); this.emit({ type: 'closed', key, generation });
    });
    try {
      const state = await client.request('get_state', {}, 60_000);
      const models = await client.request('get_available_models');
      const commands = await client.request('get_commands');
      if (!run.policyReady) throw new Error('Desktop 工具权限扩展未成功加载，已断开 pi。');
      const cleanModel = (m: any) => ({ id: String(m.id), name: String(m.name || m.id), provider: String(m.provider), reasoning: !!m.reasoning, input: Array.isArray(m.input) ? m.input : undefined });
      view.models = (models?.models || []).map(cleanModel);
      view.model = state?.model ? cleanModel(state.model) : undefined;
      view.commands = (commands?.commands || []).map((c: any) => ({ name: String(c.name), description: c.description, source: c.source, path: c.path ?? String(c.sourceInfo?.path ?? '') }));
      view.thinkingLevel = state?.thinkingLevel ?? 'off';
      view.thinkingLevels = (await client.request('get_available_thinking_levels').catch(() => ({levels: []})))?.levels ?? [];
      view.status = state?.isStreaming || state?.isCompacting ? 'running' : 'idle';
      this.emit({ type: 'run', run: { ...view } }); this.emit({ type: 'sessions-changed' });
      this.refreshContextUsage(run);
      return { ...view };
    } catch (err) { this.close(key); throw err; }
  }
  private onEvent(run: Running, event: Record<string, any>) {
    if (this.active.get(run.view.key) !== run) return;
    const { key, generation } = run.view;
    if (event.type === 'extension_ui_request') {
      const req = event as unknown as PiUiRequest;
      if (req.method === 'setStatus' && req.statusKey === 'desktop-policy' && req.statusText) run.policyReady = true;
      if (run.view.status === 'stopping' && ['select', 'confirm', 'input', 'editor'].includes(req.method)) { run.client.send({ type: 'extension_ui_response', id: req.id, cancelled: true }); return; }
      if (['select', 'confirm', 'input', 'editor'].includes(req.method)) {
        const timer = typeof req.timeout === 'number' && Number.isFinite(req.timeout) && req.timeout > 0 ? setTimeout(() => { run.dialogs.delete(req.id); this.emit({ type: 'rpc', key, generation, event: { type: 'ui-expired', id: req.id } }); }, Math.max(0, req.timeout)) : undefined;
        run.dialogs.set(req.id, { timer, method: req.method, request: req });
      }
      this.emit({ type: 'ui', key, generation, request: req }); return;
    }
    if (event.type === 'agent_start' || event.type === 'auto_retry_start' || event.type === 'compaction_start') {
      if (!run.view.timing || run.view.timing.endedAt !== undefined) run.view.timing = { startedAt: Date.now() };
      run.view.status = 'running';
      run.view.planReady = false;
    }
    if (event.type === 'agent_settled') {
      this.clearDialogs(run);
      if (run.view.timing) run.view.timing = { ...run.view.timing, endedAt: Date.now() }; run.view.status = 'idle'; run.view.pending = 0; run.view.queue = [];
      this.refreshContextUsage(run);
      void this.flushPendingSwitches(key);
    }
    // 一次模型调用刚结束、下一次尚未开始：挂起的模型/思考切换在这里下发，并顺带刷新上下文占用。
    if (event.type === 'message_end' && event.message?.role === 'assistant' && event.message?.stopReason !== 'error' && event.message?.stopReason !== 'aborted') { void this.flushPendingSwitches(key); this.refreshContextUsage(run); }
    if (event.type === 'message_end' && event.message?.role === 'assistant' && event.message?.stopReason !== 'error' && event.message?.stopReason !== 'aborted' && event.message?.content?.some((c: any) => c.type === 'text' && c.text?.trim()) && run.view.accessMode === 'plan') run.view.planReady = true;
    if (event.type === 'queue_update') {
      run.view.queue = (['steering','followUp'] as const).flatMap(kind => (Array.isArray(event[kind]) ? event[kind] : []).map((item: any) => ({text: typeof item === 'string' ? item : String(item.text ?? item.message ?? ''), behavior: kind === 'steering' ? 'steer' as const : 'followUp' as const})));
      run.view.pending = run.view.queue.length;
    }
    // Event-level subagent persistence: works for ANY subagent implementation
    // (official, npm pi-subagents, custom) by observing RPC events, not extension internals.
    if (['tool_execution_start', 'tool_execution_update', 'tool_execution_end'].includes(event.type) && event.toolName === 'subagent') {
      persistSubagentEvent(this.env.agentDir, key, String(event.toolCallId ?? ''), event);
    }
    this.emit({ type: 'rpc', key, generation, event });
    // message_update / tool_execution_update 逐 delta 到达（每秒几十个），上面的分支
    // 不会在它们上改 view；逐条重发完整 run 视图只会让渲染层每秒白渲染几十次。
    if (event.type !== 'message_update' && event.type !== 'tool_execution_update') this.emit({ type: 'run', run: { ...run.view } });
  }
  async prompt(key: string, text: string, behavior: 'steer' | 'followUp', images?: import('../../shared/composer').PiImage[]) {
    if (!text.trim() || text.length > 200_000) throw new Error('输入为空或超过 200000 字符');
    const run = this.get(key);
    if (!['idle', 'running'].includes(run.view.status)) throw new Error('当前会话暂不能发送');
    if (run.input.permission === 'plan' && text.trimStart().startsWith('/')) throw new Error('计划模式不运行斜杠命令，请使用普通输入研究项目。');
    if (images !== undefined && !Array.isArray(images)) throw new Error('图片格式无效');
    if (images?.length) {
      if (!Array.isArray(images) || images.length > 10 || images.some(i => !i || i.type !== 'image' || !['image/png','image/jpeg','image/webp','image/gif'].includes(i.mimeType) || typeof i.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(i.data)) || images.reduce((n,i)=>n+i.data.length,0) > 10*1024*1024) throw new Error('图片格式无效或总大小超过 10 MiB，请减少图片。');
      if (run.view.model?.input && !run.view.model.input.includes('image')) throw new Error('当前模型不支持图片，请选择支持图片的模型。');
    }
    await run.client.request('prompt', { message: text, streamingBehavior: behavior, ...(images?.length ? {images} : {}) }, 300_000);
  }
  async stop(key: string) {
    const run = this.get(key);
    run.view.status = 'stopping'; this.emit({ type: 'run', run: { ...run.view } });
    // Resolve dialogs first; extension commands can otherwise block the RPC handler.
    for (const id of run.dialogs.keys()) run.client.send({ type: 'extension_ui_response', id, cancelled: true });
    this.clearDialogs(run);
    const queue = await run.client.request('clear_queue');
    await run.client.request('abort', {}, 30_000);
    if (run.view.timing && run.view.timing.endedAt === undefined) run.view.timing = { ...run.view.timing, endedAt: Date.now() };
    run.view.status = 'idle'; run.view.pending = 0; run.view.queue = []; this.emit({ type: 'run', run: { ...run.view } });
    return queue || { steering: [], followUp: [] };
  }
  /**
   * Mutate the follow-up queue of a running session. pi only exposes
   * clear_queue, so editing one item = clear + re-queue the rest (and for
   * 'now', steer the chosen item into the current run immediately).
   */
  async queueEdit(key: string, op: import('../../shared/pi').PiQueueOp) {
    const run = this.get(key);
    if (run.view.status !== 'running' && run.view.status !== 'starting') throw new Error('仅在任务运行中可以管理追问队列');
    const items = (run.view.queue ?? []).map((item) => ({ ...item }));
    if (!Number.isInteger(op.index) || op.index < 0 || op.index >= items.length) throw new Error('队列项不存在');
    if (op.type === 'edit') {
      const text = String(op.text ?? '').trim();
      if (!text || text.length > 200_000) throw new Error('内容为空或超过 200000 字符');
      items[op.index].text = text;
    }
    // 'edit' keeps the item in place; 'remove' drops it; 'now' steers it into the run.
    const target = op.type === 'edit' ? undefined : items.splice(op.index, 1)[0];
    await run.client.request('clear_queue');
    // pi 的 prompt 响应依赖 preflight 回调，回合边界期可能长时间不回（消息其实
    // 已进入 agent 队列）——不能同步等待，否则「立即」在 UI 上像没反应。
    const fire = (body: Record<string, unknown>) => { void run.client.request('prompt', body, 30_000).catch(() => undefined); };
    if (op.type === 'now' && target) fire({ message: target.text, ...(target.images ?? op.images ? { images: target.images ?? op.images } : {}), streamingBehavior: 'steer' });
    for (const item of items) fire({ message: item.text, streamingBehavior: item.behavior });
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
  close(key: string) { const run = this.active.get(key); if (!run) return; this.active.delete(key); this.clearDialogs(run); run.client.close(); fs.rm(path.join(this.ownedRoot, `.mode-${key}`), () => undefined); this.emit({ type: 'closed', key, generation: run.view.generation }); }
  async refresh(key: string) { const run = this.get(key); if (run.view.status !== 'idle' || run.view.pending || run.dialogs.size) throw new Error('会话仍在运行或等待交互，请完成或停止后刷新。'); const input = run.input; const executionMode = run.view.executionMode; const timing = run.view.timing; this.close(key); await this.launch(input); const active = this.get(key); active.view.executionMode = executionMode; active.view.timing = timing; this.emit({ type: 'run', run: { ...active.view } }); return { ...active.view }; }
  dispose() { for (const key of this.active.keys()) this.close(key); }
}
