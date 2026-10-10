import type { AttachmentInput, PiImage, ContextItem, ThinkingLevel } from './composer';
import type { AccessMode } from './access-mode';
import type { SettingsApi as importSettingsApi } from './settings';
/** Desktop contracts, deliberately independent of a particular pi SDK build.
 * `'auto'` = prefer a compatible local CLI, fall back to the bundled runtime; this keeps
 * desktop's pi version in lockstep with the user's own `pi update self` upgrades. */
export type PiRuntimeMode = 'auto' | 'bundled' | 'system' | 'custom';
export interface PiPreferences { runtime?: PiRuntimeMode; executable?: string; agentDir?: string; sessionDirs?: string[] }
export interface PiEnvironment {
  runtime?: PiRuntimeMode; requestedRuntime?: PiRuntimeMode; launchArgs?: string[]; customExecutable?: string; fallback?: boolean;
  executable: string | null; version: string | null; supported: boolean; agentDir: string; sessionDirs: string[]; diagnostics: string[];
  /** The local CLI pi version (PATH discovery), even when desktop runs the bundled copy. Drives the sync banner. */
  systemVersion?: string | null;
  /** The local CLI pi path, used to run `pi update self` from the sync banner. */
  systemExecutable?: string | null;
  /** Whether the discovered local CLI is in the supported compatibility range. */
  systemSupported?: boolean;
  /** The bundled runtime's pi version (resources/pi-runtime), even when desktop runs the local CLI. */
  bundledVersion?: string | null;
}
export interface PiUpgradeResult { exitCode: number; stdout: string; stderr: string }
export interface PiSession { key: string; id: string; path: string; cwd: string; name: string; updatedAt: number; size: number; warnings: string[]; owned: boolean; parentSession?: string }
export interface PiEntry { type: string; id?: string; parentId?: string | null; timestamp?: string; message?: Record<string, unknown>; [key: string]: unknown }
export interface PiHistory { session: PiSession; entries: PiEntry[]; branch: PiEntry[]; leaves: string[]; leafId: string | null; syncedAt: number }
export interface PiResource { id: string; name: string; kind: string; path: string; scope: 'user' | 'project'; status: 'discovered' | 'callable' | 'disabled' | 'missing' | 'error'; detail: string }
export interface PiCommand { name: string; description?: string; source?: string; path?: string }
export interface PiModel { id: string; name: string; provider: string; reasoning?: boolean; input?: string[] }
export interface PiUiRequest { id: string; method: string; title?: string; message?: string; options?: string[]; placeholder?: string; prefill?: string; timeout?: number; [key: string]: unknown }
/** Host-owned outer groups. CLI auto_retry_* attempt/maxAttempts remain separate. */
export interface PiRetryGroup {
  group: number; maxGroups: number;
  phase: 'running' | 'waiting' | 'completed' | 'exhausted' | 'cancelled' | 'failed';
  delayMs?: number; nextRetryAt?: number; error?: string;
}
export interface PiRun { retryGroup?: PiRetryGroup; queue?: {text: string; behavior: 'steer' | 'followUp'; images?: PiImage[]; pendingSync?: boolean}[]; pendingModel?: { provider: string; id: string }; pendingThinking?: ThinkingLevel; thinkingLevel?: ThinkingLevel; thinkingLevels?: ThinkingLevel[]; planReady?: boolean; accessMode?: AccessMode; executionMode?: Exclude<AccessMode, 'plan'>; timing?: { startedAt: number; endedAt?: number }; compacting?: boolean; key: string; generation: string; cwd: string; file: string; status: 'starting' | 'idle' | 'running' | 'stopping' | 'error'; /** starting 期的子阶段：loading=会话历史加载中（大会话可长达数分钟），就绪后置 undefined。 */ stage?: 'loading'; model?: PiModel; models: PiModel[]; commands: PiCommand[]; pending: number; error?: string; contextDetails?: import('./context-details').ContextDetails; contextUsage?: { tokens: number; contextWindow: number; percent: number }; stats?: PiSessionStats }
export interface PiSessionStats { tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }; cost?: number; totalMessages?: number; toolCalls?: number }
export type PiEvent = { type: 'sessions-changed' } | { type: 'resources-changed' } | { type: 'run'; run: PiRun } | { type: 'rpc'; key: string; generation: string; event: Record<string, unknown> } | { type: 'ui'; key: string; generation: string; request: PiUiRequest } | { type: 'closed'; key: string; generation: string } | { type: 'compaction-record'; key: string; generation: string; /** 留痕 entry 的 data.at（扩展写入的时间戳），用于匹配过程流里的压缩记录 */ at: number; /** 压缩后投影 tokens（compaction_end result.estimatedTokensAfter，与 tokensBefore 同口径） */ tokensAfter: number; contextWindow: number };
export interface PiReview { root: string; baseline: string; diff: string; untracked: string[]; untrackedFiles?: { path: string; lines: number }[]; warning?: string }
export type PiQueueOp = { type: 'remove'; index: number } | { type: 'edit'; index: number; text: string } | { type: 'now'; index: number; /** 队列项附带图片（pi 的 queue_update 不回传，由桌面端在点击时补上）。 */ images?: PiImage[] };
/** A pi package physically present / registered in the agent dir. */
export interface PiInstalledPackage { name: string; spec: string; version: string; description: string; registered: boolean; kinds: string[]; path: string; enabled?: boolean }
/** A marketplace entry from the npm registry (pi-package ecosystem). */
export interface PiMarketPackage { name: string; version: string; description: string; publisher: string; keywords: string[]; link: string }

// ---------------------------------------------------------------------------
// Remote viewer (LAN QR) + IM notification bot. Both are desktop-owned,
// outbound-only features; nothing here can reach pi credentials.
// ---------------------------------------------------------------------------

export interface RemoteStatus { running: boolean; port?: number; token?: string; urls: string[]; viewers?: number }
export type ImProviderId = 'off' | 'dingtalk' | 'feishu' | 'telegram' | 'wechat';
/** 微信渠道的推送后端（微信无出站 bot API，走第三方服务号通道推送通知）。 */
export type ImPushProvider = 'serverchan' | 'pushplus';
export interface ImConfig {
  provider: ImProviderId;
  /** Push webhook (dingtalk/feishu custom bot) for one-way lifecycle notices. */
  webhook: string;
  secret?: string;
  /**
   * Two-way channel credentials. appKey/appSecret drive the DingTalk Stream /
   * Feishu long connection; botToken drives Telegram long-polling. Stored in
   * the desktop's own config file, never sent anywhere but the vendor API.
   */
  appKey?: string;
  appSecret?: string;
  /** Telegram: bot token from @BotFather; wechat: Server酱 SendKey / PushPlus token. */
  botToken?: string;
  /** 微信渠道推送后端，默认 serverchan。 */
  pushProvider?: ImPushProvider;
  /** DingTalk Stream / Feishu long-connection switch (two-way chat). */
  twoWay?: boolean;
  /** Per-chat bindings (chatId → bound workspace), persisted by the desktop. */
  bindings?: Record<string, { cwd?: string; mode?: string }>;
  notifyCompleted: boolean;
  notifyError: boolean;
  notifyAttention: boolean;
}
export interface LocalPiApi extends importSettingsApi {
  automationSnapshot(): Promise<import('./automation').AutomationSnapshot>;
  automationSaveTask(input: import('./automation').AutomationTask): Promise<import('./automation').AutomationTask>;
  automationDeleteTask(id:string): Promise<void>;
  automationToggle(id:string): Promise<void>;
  automationRunTask(id:string): Promise<import('./automation').AutomationRun>;
  automationSaveWorkflow(input:import('./automation').SavedWorkflow): Promise<import('./automation').SavedWorkflow>;
  automationDeleteWorkflow(id:string): Promise<void>;
  automationRunWorkflow(input:import('./automation').WorkflowLaunch): Promise<import('./automation').AutomationRun>;
  automationStop(id:string): Promise<void>;
  automationExport(id:string): Promise<boolean>;
  automationImport(): Promise<import('./automation').SavedWorkflow | null>;
  onAutomationChanged(listener:()=>void): ()=>void;
  composerSkills(cwd?: string): Promise<import('./settings').EditableResource[]>;
  /** 语音输入：ASR 模型列表读写（apiKey 明文不出主进程）+ 云端转写。 */
  voiceConfig(): Promise<import('./voice').VoiceConfig>;
  voiceSaveModel(input: import('./voice').VoiceAsrModelInput): Promise<import('./voice').VoiceConfig>;
  voiceRemoveModel(id: string): Promise<import('./voice').VoiceConfig>;
  voiceSetActive(id: string): Promise<import('./voice').VoiceConfig>;
  voiceTranscribe(bytes: Uint8Array, mime: string): Promise<import('./voice').VoiceTranscribeResult>;
  projectFiles(cwd: string): Promise<string[]>;
  projectContext(cwd: string, relative: string): Promise<ContextItem>;
  importAttachments(files: AttachmentInput[]): Promise<ContextItem[]>;
  clipboardAttachments(): Promise<ContextItem[]>;
  /** 已发送图片下载：弹保存对话框写盘，取消返回空串。 */
  downloadImage(name: string, dataUrl: string): Promise<string>;
  pickDocuments(): Promise<ContextItem[]>;
  projectBranch(cwd: string): Promise<string | null>;
  thinking(key: string, level: ThinkingLevel): Promise<void>;
  environment(): Promise<PiEnvironment>;
  configure(value: PiPreferences): Promise<PiEnvironment>;
  /** Re-discover the pi runtime (after an upgrade) without changing preferences. */
  refreshEnvironment(): Promise<PiEnvironment>;
  /** Run `pi update self` against the discovered local CLI; resolves the captured output. */
  upgradeLocalPi(): Promise<PiUpgradeResult>;
  sessions(): Promise<PiSession[]>;
  archivedSessions(): Promise<string[]>;
  setSessionArchived(key: string, archived: boolean): Promise<string[]>;
  /** 手动删除归档会话：会话文件移到系统废纸篓（可恢复），索引条目随之清除。 */
  deleteArchivedSession(key: string): Promise<string[]>;
  history(key: string, leafId?: string): Promise<PiHistory>;
  resources(cwd?: string): Promise<PiResource[]>;
  connect(input: { sourceKey?: string; cwd?: string; trustProject: boolean; permission: AccessMode; executionMode?: Exclude<AccessMode, 'plan'> }): Promise<PiRun>;
  runs(): Promise<PiRun[]>;
  prompt(key: string, text: string, behavior: 'steer' | 'followUp', images?: PiImage[]): Promise<void>;
  /** 手动压缩会话上下文（内置 /compact：pi RPC 专用 compact 命令，get_commands 不含内置命令）。 */
  compact(key: string, customInstructions?: string): Promise<{ summary: string; tokensBefore?: number }>;
  /** 内置 /reload：重启 pi 并重连同一会话（历史完整保留），等效热重载扩展/skills/prompts/主题。 */
  sessionReload(key: string): Promise<PiRun>;
  /** 按需重拉斜杠命令列表（补全面板为空时自愈）；返回最新命令数。 */
  refreshCommands(key: string): Promise<number>;
  refreshModels(key: string): Promise<number>;
  stop(key: string): Promise<{ steering: string[]; followUp: string[] }>;
  /** Mutate the queued follow-ups of a running session: remove / edit / steer-now. */
  queueEdit(key: string, op: PiQueueOp): Promise<void>;
  /** pi 包管理：已装列表 / npm 市场搜索 / pi install|remove / 注册未登记的本地包。 */
  packageList(): Promise<PiInstalledPackage[]>;
  packageSearch(query: string): Promise<PiMarketPackage[]>;
  /** 市场封面缩略图候选 URL（README 首图，多镜像）。 */
  packageCovers(names: string[]): Promise<Record<string, string[]>>;
  packageInstall(source: string, action: 'install' | 'remove'): Promise<string>;
  packageRegister(spec: string): Promise<void>;
  close(key: string): Promise<void>;
  refresh(key: string): Promise<PiRun>;
  setAccessMode(key: string, mode: AccessMode): Promise<PiRun>;
  model(key: string, provider: string, modelId: string): Promise<void>;
  respond(key: string, generation: string, response: { id: string; value?: string; confirmed?: boolean; cancelled?: boolean }): Promise<void>;
  /** 编辑已发送消息：pi fork RPC 把会话树截断回该条目，返回被编辑消息的原文。 */
  forkMessage(key: string, entryId: string): Promise<string>;
  filePreview(cwd: string, file: string): Promise<{path: string; content?: string; diff: string; note: string; image?: {mime: string; base64: string}}>;
  gitStatus(cwd: string): Promise<import('./conversation-status').GitStatus>;
  review(cwd: string): Promise<PiReview>;
  officialSubagentStatus(): Promise<{installed:boolean;thirdParty:boolean;thirdPartySource?:string;outdated:boolean;scoutExists:boolean;path:string}>;
  enableOfficialSubagent(): Promise<{path:string;upgraded:boolean}>;
  recoverSubagents(sessionKey: string): Promise<Array<{callId:string;status:string;details?:unknown;error?:string;startedAt?:number;updatedAt?:number}>>;
  /** 记忆衔接层状态：探测 CLI 记忆插件并返回当前链路。 */
  memoryAssistStatus(enabled: boolean): Promise<{ enabled: boolean; plugin: { kind: 'extension'; id: string; label?: string } | { kind: 'builtin' }; builtinDir: string; hint: string }>;
  /** 无 cwd 仅全局；指定 cwd 时附加项目 .pi/memory 与旧版路径映射文件（可能共用），仍包含全局。 */
  memoryList(cwd?: string): Promise<Array<{ name: string; path: string; bytes: number; updatedAt: number; scope: 'global' | 'project'; entries: number; rel: string; /** 旧版 projects/ 映射文件的归属项目名（无法识别时缺失）。 */ project?: string; /** 唯一归属项目路径（共用/未识别时缺失），可用于迁移。 */ projectPath?: string }>>;
  /** 只读预览；projects-external/ 相对路径必须携带列举时的 cwd。 */
  memoryRead(rel: string, cwd?: string): Promise<string>;
  memoryOpen(rel: string, cwd: string | undefined, appId: string): Promise<void>;
  /** 把旧版 projects/ 映射文件迁回唯一归属项目 <项目>/.pi/memory/legacy/。 */
  memoryMigrateLegacy(rel: string): Promise<{ movedTo: string }>;
  /** 把全局记忆中的主题文件移入指定项目 <项目>/.pi/memory/<name>.md。 */
  memoryMoveToProject(rel: string, projectPath: string): Promise<{ movedTo: string }>;
  /** 一键启用内置默认记忆插件（未装 → pi install；已装未登记 → 补注册）。 */
  memoryEnableDefault(): Promise<{ installed: boolean; registered: boolean }>;

  cleanupSubagents(sessionKey: string): Promise<void>;
  modelCatalog(): Promise<PiModelCatalog>;
  planQuota(provider: string): Promise<import('./context-details').PlanQuota>;
  /** 直连生图：provider/model 来自目录（imageModels），走内置 ModelRuntime 凭证。 */
  imageGenerate(provider: string, model: string, prompt: string): Promise<PiImageGenResult>;
  accountLogin(provider:string): Promise<PiAccountLogin>;
  accountStatus(id:string): Promise<PiAccountLogin>;
  accountAnswer(id:string,promptId:string,value:string): Promise<void>;
  accountCancel(id:string): Promise<void>;
  accountOpen(id:string): Promise<void>;
  remoteStart(): Promise<RemoteStatus>;
  remoteStop(): Promise<RemoteStatus>;
  remoteStatus(): Promise<RemoteStatus>;
  imConfig(): Promise<ImConfig>;
  imSave(patch: Partial<ImConfig>): Promise<ImConfig>;
  imTest(): Promise<void>;
  /** 钉钉扫码一键配置：应用注册 device flow。 */
  dingtalkRegister: {
    start: () => Promise<{ url: string; deviceCode: string; userCode: string; intervalMs: number; expireInMs: number }>;
    poll: (deviceCode: string) => Promise<{ done: boolean; status: 'waiting' | 'success' | 'fail' | 'expired'; clientId?: string; clientSecret?: string; error?: string }>;
  };
  pickDirectory(): Promise<string | null>;
  /** Show a local file/folder in the OS file manager (session context menu). */
  revealPath(path: string): Promise<void>;
  /** 已安装的外部应用白名单（用外部应用打开当前项目）。 */
  externalApps(): Promise<import('./open-with').ExternalApp[]>;
  /** 用白名单内的外部应用打开项目目录；cwd 必须是已授权项目/会话/运行中工作区。 */
  openWith(cwd: string, appId: string): Promise<void>;
  /** 内置终端：pty 会话（主进程 node-pty，渲染端 xterm）。 */
  terminalCreate(input?: import('./terminal').TerminalCreateInput): Promise<import('./terminal').TerminalInfo>;
  terminalWrite(id: string, data: string): Promise<void>;
  terminalResize(id: string, cols: number, rows: number): Promise<void>;
  terminalKill(id: string): Promise<void>;
  onTerminalData(listener: (event: import('./terminal').TerminalDataEvent) => void): () => void;
  onTerminalExit(listener: (event: import('./terminal').TerminalExitEvent) => void): () => void;
  /** Shared-config writes: pi reads the same settings.json / models.json. */
  modelDefaultSave(input: { provider?: string; model?: string }): Promise<PiModelCatalog>;
  modelProviderSave(provider: PiModelProviderDraft): Promise<PiModelCatalog>;
  modelProviderAuthSave(input: { id: string; apiKey?: string; clear?: boolean }): Promise<PiModelCatalog>;
  modelProviderRemove(id: string): Promise<PiModelCatalog>;
  usageStats(): Promise<PiUsageStats>;
  onEvent(callback: (event: PiEvent) => void): () => void;
  /** 应用更新：查询最近一次检查结果（启动后 10s 首查，之后每 6h 静默复查）。 */
  updateStatus(): Promise<UpdateStatus>;
  /** 打开新版本的 release 页；无可用更新时静默无操作。 */
  updateOpen(): Promise<void>;
  /** 订阅后续检查结果（主进程推送）。返回退订函数。 */
  onUpdateStatus(callback: (status: UpdateStatus) => void): () => void;
}

/** 应用更新检查状态（main/update-check.ts 产出，GitHub Releases 比对 app.getVersion()）。 */
export interface UpdateStatus {
  available: boolean;
  current: string;
  latest?: string;
  url?: string;
  checkedAt: number;
}

// ---------------------------------------------------------------------------
// Read-only model catalog (pi configuration, secrets stripped server-side).
// ---------------------------------------------------------------------------

export type PiModelEditableField = 'name' | 'contextWindow' | 'maxTokens' | 'reasoning' | 'input' | 'thinkingLevelMap' | 'samplingParamsByThinkingLevel';
export interface PiCatalogModel { definition?: 'custom' | 'override'; thinkingLevelMap?: Partial<Record<'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max', string | null>>;
  /** Per-level sampling params (pi 1.0.2+), e.g. {"temperature":0.7}; mirrors models-config schema. */
  samplingParamsByThinkingLevel?: Partial<Record<'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max', Record<string, unknown>>>; id: string; name?: string; contextWindow?: number; maxTokens?: number; reasoning?: boolean; input?: string[] }
export interface PiCatalogImageModel { id: string; name?: string }
export interface PiCatalogProvider {
  loginAvailable?: boolean;
  id: string;
  name?: string;
  baseUrl?: string;
  api?: string;
  /** How this provider authenticates — presence only, never the secret. */
  auth: 'api_key' | 'oauth' | 'none';
  /** Where the provider definition comes from. */
  source: 'models.json' | 'auth';
  models: PiCatalogModel[];
  /** Image (text-to-image) models; absent when the runtime predates pi 0.99. */
  imageModels?: PiCatalogImageModel[];
}
/** Result of a direct text-to-image generation via the bundled ModelRuntime. */
export interface PiImageGenResult { images: { mime: string; data: string }[] }
export interface PiAccountLogin {
  id:string; provider:string; status:'waiting'|'done'|'error'|'cancelled'; message:string;
  url?:string; deviceCode?:string;
  prompt?:{id:string;type:'text'|'secret'|'select'|'manual_code';message:string;placeholder?:string;options?:{id:string;label:string;description?:string}[]};
}
export interface PiModelCatalog {
  warning?: string;
  defaultProvider?: string;
  defaultModel?: string;
  providers: PiCatalogProvider[];
}
/** Draft for creating/updating a custom provider in models.json (shared with pi CLI). */
export interface PiModelProviderDraft {
  id: string;
  name?: string;
  baseUrl: string;
  api?: string;
  /** New key to store; omit/empty on update to keep the existing one. */
  apiKey?: string;
  models: PiCatalogModel[];
  /** Single-model patch (or delete): never replace a provider or replay other models from the renderer. */
  modelEdit?: { originalId?: string; kind: 'custom' | 'override' | 'delete'; fields?: PiModelEditableField[] };
}
/** Aggregated usage statistics computed from local pi session files. */
export interface PiUsageStats {
  sessions: number;
  userMessages: number;
  assistantMessages: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: number;
  byModel: Array<{ model: string; provider: string; calls: number; input: number; output: number; cacheRead: number; cacheWrite: number; total: number; cost: number }>;
  byDay: Array<{ day: string; tokens: number; cost: number; messages: number }>;
  byProject: Array<{ cwd: string; sessions: number; tokens: number; cost: number }>;
}
