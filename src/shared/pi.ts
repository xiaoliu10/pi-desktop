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
export interface PiRun { queue?: {text: string; behavior: 'steer' | 'followUp'; images?: PiImage[]; pendingSync?: boolean}[]; pendingModel?: { provider: string; id: string }; pendingThinking?: ThinkingLevel; thinkingLevel?: ThinkingLevel; thinkingLevels?: ThinkingLevel[]; planReady?: boolean; accessMode?: AccessMode; executionMode?: Exclude<AccessMode, 'plan'>; timing?: { startedAt: number; endedAt?: number }; key: string; generation: string; cwd: string; file: string; status: 'starting' | 'idle' | 'running' | 'stopping' | 'error'; model?: PiModel; models: PiModel[]; commands: PiCommand[]; pending: number; error?: string; contextDetails?: import('./context-details').ContextDetails; contextUsage?: { tokens: number; contextWindow: number; percent: number }; stats?: PiSessionStats }
export interface PiSessionStats { tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }; cost?: number; totalMessages?: number; toolCalls?: number }
export type PiEvent = { type: 'sessions-changed' } | { type: 'resources-changed' } | { type: 'run'; run: PiRun } | { type: 'rpc'; key: string; generation: string; event: Record<string, unknown> } | { type: 'ui'; key: string; generation: string; request: PiUiRequest } | { type: 'closed'; key: string; generation: string };
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
export type ImProviderId = 'off' | 'dingtalk' | 'feishu' | 'telegram';
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
  botToken?: string;
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
  projectFiles(cwd: string): Promise<string[]>;
  projectContext(cwd: string, relative: string): Promise<ContextItem>;
  importAttachments(files: AttachmentInput[]): Promise<ContextItem[]>;
  clipboardAttachments(): Promise<ContextItem[]>;
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
  history(key: string, leafId?: string): Promise<PiHistory>;
  resources(cwd?: string): Promise<PiResource[]>;
  connect(input: { sourceKey?: string; cwd?: string; trustProject: boolean; permission: AccessMode; executionMode?: Exclude<AccessMode, 'plan'> }): Promise<PiRun>;
  runs(): Promise<PiRun[]>;
  prompt(key: string, text: string, behavior: 'steer' | 'followUp', images?: PiImage[]): Promise<void>;
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
  filePreview(cwd: string, file: string): Promise<{path: string; content?: string; diff: string; note: string}>;
  gitStatus(cwd: string): Promise<import('./conversation-status').GitStatus>;
  review(cwd: string): Promise<PiReview>;
  officialSubagentStatus(): Promise<{installed:boolean;thirdParty:boolean;thirdPartySource?:string;outdated:boolean;scoutExists:boolean;path:string}>;
  enableOfficialSubagent(): Promise<{path:string;upgraded:boolean}>;
  recoverSubagents(sessionKey: string): Promise<Array<{callId:string;status:string;details?:unknown;error?:string;startedAt?:number;updatedAt?:number}>>;
  /** 记忆衔接层状态：探测 CLI 记忆插件并返回当前链路。 */
  memoryAssistStatus(enabled: boolean): Promise<{ enabled: boolean; plugin: { kind: 'extension'; id: string } | { kind: 'builtin' }; builtinDir: string; hint: string }>;
  /** 记忆衔接层：列举记忆文件（内置桥 + pi-memory 约定目录）。 */
  memoryList(cwd?: string): Promise<Array<{ name: string; path: string; bytes: number; updatedAt: number; scope: 'global' | 'project' }>>;

  cleanupSubagents(sessionKey: string): Promise<void>;
  modelCatalog(): Promise<PiModelCatalog>;
  planQuota(provider: string): Promise<import('./context-details').PlanQuota>;
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
  modelProviderRemove(id: string): Promise<PiModelCatalog>;
  usageStats(): Promise<PiUsageStats>;
  onEvent(callback: (event: PiEvent) => void): () => void;
}

// ---------------------------------------------------------------------------
// Read-only model catalog (pi configuration, secrets stripped server-side).
// ---------------------------------------------------------------------------

export interface PiCatalogModel { thinkingLevelMap?: Partial<Record<'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max', string | null>>; id: string; name?: string; contextWindow?: number; maxTokens?: number; reasoning?: boolean; input?: string[] }
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
}
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
