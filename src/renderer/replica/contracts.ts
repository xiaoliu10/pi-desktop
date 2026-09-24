/**
 * Frozen UI contracts for the replica phase (U01).
 *
 * Replica pages consume ONLY the prop interfaces below; all state lives in
 * the preview adapter (src/renderer/preview/adapter.ts). When phase 2 (pi
 * integration) replaces the adapter, these contracts stay: the real backend
 * implements the same callbacks with live data.
 *
 * Everything here is UI-state only — no model calls, no filesystem access,
 * no plugin execution. Demo data lives in ../preview/fixtures.ts.
 */

import type { ReactNode } from 'react';
import type { IconName } from './Icons';
import type { PiImage } from '../../shared/composer';
export type { PiImage };

// ---------------------------------------------------------------------------
// Navigation & sessions (U02)
// ---------------------------------------------------------------------------

export type SessionSource = 'desktop' | 'pi-cli';

export interface SessionNavItem {
  id: string;
  title: string;
  updatedAt: number;
  /** pi-cli sessions are read-only observations with a sync time. */
  source: SessionSource;
  /** For pi-cli: ISO time of last observed disk sync (demo string). */
  syncedAt?: string;
  /** For pi-cli: whether "continue in Desktop" hand-off is offered. */
  canContinue?: boolean;
  /** Demo state flag shown in the row (e.g. "running" dot in reference). */
  busy?: boolean;
  pinned?: boolean;
  /** Working directory of the session (context menu: copy path). */
  cwd?: string;
  /** Session file on disk (context menu: reveal in Finder). */
  path?: string;
}

export interface ProjectNavItem {
  pinned?: boolean;
  section?: string;
  id: string;
  name: string;
  path: string;
  sessions: SessionNavItem[];
  expanded: boolean;
  /** True when no sessions exist yet (renders the empty hint row). */
  emptyHint?: boolean;
}

export interface SidebarProps {
  onAddProject?: () => void;
  addingProject?: boolean;
  onOpenSearch?: () => void;
  onOpenAutomations?: () => void;
  shortcutHints?: { newSession: string; search: string };
  searchOpen?: boolean;

  projects: ProjectNavItem[];
  projectMenu?: (project: ProjectNavItem) => ReactNode;
  /** Sessions not associated with a project (temporary chats). */
  temporarySessions: SessionNavItem[];
  activeSessionId: string | null;
  collapsed: boolean;
  version: string;
  labels: SidebarLabels;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
  onToggleProject: (id: string) => void;
  onToggleCollapse: () => void;
  onOpenSettings: () => void;
  onOpenPlugins: () => void;
  onToggleNotifications: () => void;
  /** Rename a session's desktop display name (Electron has no window.prompt). */
  onRenameSession?: (id: string, name: string) => void;
  onArchiveSession?: (id: string) => void;
  onOpenArchive?: () => void;
  archivedCount?: number;
  notificationsCount?: number;
  activeOverlay?: 'plugins' | 'settings' | 'notifications' | 'automations' | null;
  /** 前进/后退导航（ZCode 顶栏按钮复刻）；preview 不传则不渲染。 */
  onNavBack?: () => void;
  onNavForward?: () => void;
  canNavBack?: boolean;
  canNavForward?: boolean;
  navLabels?: { back: string; forward: string };
}

export interface SidebarLabels {
  sessions: string;
  projects: string;
  noChats: string;
  newSession: string;
  search: string;
  settings: string;
  plugins: string;
  notifications: string;
  readOnlyBadge: string;
  continueHere: string;
  /** Toggle shown when a project has more sessions than the visible limit. */
  showAllSessions?: string;
  collapseSessions?: string;
}

export interface TopBarProps {
  title: string;
  labels: TopBarLabels;
  onNewSession: () => void;
  onOpenSearch: () => void;
  onToggleWorkbench: () => void;
  workbenchOpen: boolean;
  /** 内置终端切换（pi 集成传入；demo 预览不传则不渲染）。 */
  onToggleTerminal?: () => void;
  terminalOpen?: boolean;
  /** 顶栏「打开方式」分割按钮插槽（pi 集成传入；demo 预览不传）。 */
  openWith?: ReactNode;
}

export interface TopBarLabels {
  newSession: string;
  search: string;
  workbench: string;
  terminal?: string;
}

// ---------------------------------------------------------------------------
// Composer (U03)
// ---------------------------------------------------------------------------

export type AgentMode = 'agent' | 'plan' | 'goal';
export type PermissionChoice = 'ask' | 'autoedit' | 'full';
export type ReasoningLevel = 'off' | 'low' | 'medium' | 'high';

export interface ModelGroup {
  provider: string;
  models: ModelOption[];
}

export interface ModelOption {
  id: string;
  name: string;
  detail?: string;
}

export interface SlashCommand {
  name: string;
  description: string;
}

export interface ComposerProps {
  draftText?: string;
  onDraftChange?: (text: string) => void;
  preparing?: boolean;
  hasAttachments?: boolean;
  onPaste?: import('react').ClipboardEventHandler<HTMLTextAreaElement>;
  /** Null on the home screen = "ask anything" placeholder variant. */
  sessionActive: boolean;
  modelId: string;
  modelGroups: ModelGroup[];
  reasoning: ReasoningLevel;
  agentMode: AgentMode;
  permissionMode: PermissionChoice;
  slashCommands: SlashCommand[];
  files: string[];
  running: boolean;
  queued: number;
  queue?: {text: string; behavior: 'steer' | 'followUp'}[];
  /** Model chosen while running: shown with a "待生效" marker until applied. */
  pendingModelId?: string;
  /** Queue row actions (production only): steer-now / recall-into-composer / remove. */
  onQueueNow?: (index: number) => void;
  onQueueEdit?: (index: number, text: string) => void;
  /** ZCode-style edit: pull the queued prompt's text + image attachments back into the
   *  composer so the user can change both, then re-send. Replaces inline text editing. */
  onQueueRecall?: (index: number) => void;
  onQueueRemove?: (index: number) => void;
  demo: boolean;
  labels: ComposerLabels;
  /**
   * Production slot: when provided, rendered in the toolbar's left group
   * instead of the demo Agent/permission pills (e.g. pi 访问模式选择；
   * 输入策略在设置页配置，不再放在输入框).
   */
  leftSlot?: ReactNode;
  addSlot?: ReactNode;
  headerSlot?: ReactNode;
  contextSlot?: ReactNode;
  reasoningSlot?: ReactNode;
  /** Rendered in the toolbar's right group, before the model pill (e.g. context ring). */
  statusSlot?: ReactNode;
  modelDisabled?: boolean;
  /**
   * Hides the reasoning-level chip. Production pi RPC does not expose a
   * reasoning switch, so the desktop passes true rather than render a
   * control that cannot change anything.
   */
  hideReasoning?: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  onPickModel: (id: string) => void;
  onPickReasoning: (level: ReasoningLevel) => void;
  onPickAgentMode: (mode: AgentMode) => void;
  onPickPermission: (mode: PermissionChoice) => void;
}

export interface ComposerLabels {
  placeholderSession: string;
  placeholderHome: string;
  send: string;
  stop: string;
  queued: string;
  queueNow?: string;
  queueEdit?: string;
  queueRemove?: string;
  pendingSwitch?: string;
  agentMode: string;
  modeAgent: string;
  modePlan: string;
  modeGoal: string;
  permissionAsk: string;
  permissionAutoedit: string;
  permissionFull: string;
  model: string;
  reasoning: string;
  reasoningOff: string;
  reasoningLow: string;
  reasoningMedium: string;
  reasoningHigh: string;
  attachDisabled: string;
  slashCommands: string;
  atFiles: string;
  demoBadge: string;
  commandsEmpty: string;
  filesEmpty: string;
}

// ---------------------------------------------------------------------------
// Conversation (U03)
// ---------------------------------------------------------------------------

export interface ToolPart {
  /** Plugin-owned structured result; rendered only by a matching adapter. */
  resultDetails?: unknown;
  resultDetailsFinal?: boolean;
  kind: 'tool';
  id: string;
  tool: string;
  summary: string;
  status: 'done' | 'error' | 'running';
  callId?: string;
  phase?: 'call' | 'progress' | 'result';
  argumentsText?: string;
  /** Expandable detail lines (command output, file excerpt…). */
  detailLines?: string[];
  /** Demo diff attached to edit tools. */
  diff?: DemoFileDiff;
}

export interface ErrorPart {
  kind: 'error';
  id: string;
  message: string;
}

export interface NoticePart {
  kind: 'notice';
  id: string;
  text: string;
}

export type MessagePart =
  | { kind: 'image'; id: string; data: string; mimeType: string }
  | { kind: 'text'; id: string; text: string }
  | { kind: 'thinking'; id: string; text: string; durationMs?: number }
  | ToolPart
  | ErrorPart
  | NoticePart;

export interface ChatMessage {
  timestamp?: number;
  id: string;
  role: 'user' | 'assistant';
  parts: MessagePart[];
  /** Simulated runs are explicitly labeled in the UI. */
  simulated?: boolean;
  model?: string;
}

export interface ChatViewProps {
  onOpenToolFile?: (part: ToolPart) => void;
  runTiming?: { startedAt: number; endedAt?: number };
  messages: ChatMessage[];
  running: boolean;
  queued: number;
  queue?: {text: string; behavior: 'steer' | 'followUp'; images?: PiImage[]}[];
  /** True from send click until pi acknowledges the prompt: shows the optimistic
   * user bubble + working spinner immediately instead of waiting for RPC events. */
  sending?: boolean;
  /** The prompt text sent but not yet echoed by pi (rendered optimistically). */
  sendingText?: string;
  /** Client-side send timestamp: the working-row timer counts from here, before pi's own timing starts. */
  sendingAt?: number;
  /** Ongoing model auto-retry (pi auto_retry_start…auto_retry_end): the working bar shows
   *  "正在重试请求（第 N/M 次）" so a silent timeout-retry window never looks frozen. */
  retrying?: { attempt: number; max: number } | null;
  /** Model chosen while running: shown with a "待生效" marker until applied. */
  pendingModelId?: string;
  /** Queue row actions (production only): steer-now / inline edit / remove. */
  onQueueNow?: (index: number) => void;
  onQueueEdit?: (index: number, text: string) => void;
  onQueueRemove?: (index: number) => void;
  demo: boolean;
  labels: ChatLabels;
  /** Anchor element ids per message for the nav rail + jump links. */
  onJumpToMessage: (id: string) => void;
  /** 编辑并重发已发送的用户消息（fork 截断回该条目后重发）；缺省=仅复制不可编辑。 */
  onEditUserMessage?: (entryId: string, text: string) => void;
  /** 下载已发送的图片附件：dataUrl + 建议文件名；缺省=灯箱里不显示下载按钮。 */
  onDownloadImage?: (dataUrl: string, name: string) => void;
}

export interface ChatLabels {
  you: string;
  assistant: string;
  simulatedRun: string;
  toolRunning: string;
  toolDone: string;
  toolError: string;
  details: string;
  queued: string;
  working: string;
  /** 已发送用户消息的 hover 动作（对齐 ZCode chat.message.copy/edit）。 */
  copyMessage: string;
  copied: string;
  editMessage: string;
  resend: string;
  cancel: string;
  /** 图片放大预览与下载（灯箱）。 */
  viewImage: string;
  downloadImage: string;
  close: string;
}

export interface DemoDiffLine {
  type: ' ' | '+' | '-';
  text: string;
  /** 行号：删行=旧文件行号，上下文/增行=新文件行号（pi 的 edit diff 与 git hunk 都能给出）。 */
  line?: number;
}

export interface DemoFileDiff {
  path: string;
  created: boolean;
  additions: number;
  deletions: number;
  lines: DemoDiffLine[];
}

// ---------------------------------------------------------------------------
// Workbench panel (U06)
// ---------------------------------------------------------------------------

export type WorkbenchTab = 'review' | 'files' | 'browser';

export interface DemoFileNode {
  path: string;
  /** Content shown when selected (demo excerpt). */
  excerpt: string[];
}

export interface WorkbenchProps {
  cwd?: string;
  fileLine?: number;
  note?: string;
  open: boolean;
  tab: WorkbenchTab;
  diffs: DemoFileDiff[];
  files: DemoFileNode[];
  selectedFile: string | null;
  demo: boolean;
  labels: WorkbenchLabels;
  onToggle: () => void;
  onSelectTab: (tab: WorkbenchTab) => void;
  onSelectFile: (path: string | null) => void;
}

export interface WorkbenchLabels {
  review: string;
  files: string;
  browser: string;
  close: string;
  emptyReview: string;
  emptyReviewHint: string;
  emptyFiles: string;
  emptyFilesHint: string;
  emptyBrowser: string;
  emptyBrowserHint: string;
  created: string;
  selectFile: string;
}

// ---------------------------------------------------------------------------
// Plugins & marketplace (U04)
// ---------------------------------------------------------------------------

export type PluginStatus = 'attention' | 'updatable' | 'active' | 'off';
export type PluginScope = 'everywhere' | 'project';
export type PluginPermissionChip = 'edit' | 'read' | 'network' | 'spawn' | 'panel' | 'clipboard';

export interface PluginRowData {
  id: string;
  name: string;
  packageId: string;
  version: string;
  status: PluginStatus;
  scope: PluginScope;
  error?: string;
  /** Mono badge next to the name, e.g. "Local". */
  badge?: string;
  details: string[];
  latestVersion?: string;
  /** Optional primary action button (e.g. 注册 for unregistered pi packages); fires onTogglePlugin. */
  primaryAction?: string;
}

export interface MarketplaceCardData {
  id: string;
  name: string;
  verified: boolean;
  publisher: string;
  version: string;
  installs: number;
  description: string;
  permissions: PluginPermissionChip[];
  installedVersion?: string;
  /** Whether an update action is offered (installed + newer version). */
  updateAvailable?: boolean;
  published: boolean;
  tags: string[];
  /** 封面缩略图候选 URL（按序降级；为空回退首字母头像）。 */
  covers?: string[];
}

export interface PluginsPageProps {
  tab: 'installed' | 'marketplace';
  /** Hides the marketplace tab entirely (production: no marketplace backend). */
  hideMarketplace?: boolean;
  installed: PluginRowData[];
  marketplace: MarketplaceCardData[];
  search: string;
  marketplaceSource: string;
  marketplaceSources: string[];
  tag: string;
  tags: string[];
  updatesReady: number;
  demo: boolean;
  labels: PluginsLabels;
  onSelectTab: (tab: 'installed' | 'marketplace') => void;
  onSearch: (query: string) => void;
  onSelectTag: (tag: string) => void;
  onSelectSource: (source: string) => void;
  onTogglePlugin: (id: string) => void;
  onUpdatePlugin: (id: string) => void;
  onInstallPlugin: (id: string) => void;
  onOpenMarketplace: () => void;
  onRefreshMarketplace: () => void;
  onApplyUpdates: () => void;
}

export interface PluginsLabels {
  title: string;
  browseMarketplace: string;
  refreshMarketplace: string;
  installed: string;
  marketplace: string;
  searchInstalled: string;
  searchMarketplace: string;
  updatesReady: string;
  applyUpdates: string;
  needsAttention: string;
  updatesAvailable: string;
  active: string;
  turnedOff: string;
  details: string;
  update: string;
  install: string;
  installedCheck: string;
  everywhere: string;
  project: string;
  off: string;
  emptyInstalled: string;
  emptyInstalledHint: string;
  noResults: string;
  demoNote: string;
  permissionEdit: string;
  permissionRead: string;
  permissionNetwork: string;
  permissionSpawn: string;
  permissionPanel: string;
  permissionClipboard: string;
  notPublished: string;
  extensionMarketplace: string;
  allTag: string;
}

// ---------------------------------------------------------------------------
// Settings (U05)
// ---------------------------------------------------------------------------

export type SettingsNavId =
  | 'general' | 'ai' | 'shortcuts'
  | 'instructions' | 'models' | 'skills' | 'mcp' | 'extensions' | 'subagents'
  | 'workspace' | 'import' | 'projects' | 'archived' | 'usage' | 'info';

export interface SettingsNavSection {
  label: string;
  items: Array<{ id: SettingsNavId; label: string; icon: IconName }>;
}

export interface SettingRowData {
  id: string;
  title: string;
  description?: string;
  control:
    | { kind: 'select'; value: string; options: string[]; disabled?: boolean }
    | { kind: 'segmented'; value: string; options: string[] }
    | { kind: 'slider'; value: number; min: number; max: number; suffix: string; options?: string[] }
    | { kind: 'toggle'; value: boolean }
    | { kind: 'button'; label: string }
    | { kind: 'static'; text: string };
}

export interface SettingsSectionData {
  title: string;
  rows: SettingRowData[];
}

export interface ProviderCardData {
  auth?: "oauth" | "api_key" | "none";
  loginAvailable?: boolean;
  id: string;
  name: string;
  baseUrl: string;
  modelCount: number;
  isDefault: boolean;
  enabled: boolean;
  /** Where the provider definition comes from; 'auth' entries are read-only (pi sign-in). */
  source: 'models.json' | 'auth';
  /** Model rows for the detail pane (id / display name / reasoning). */
  models: import("../../shared/pi").PiCatalogModel[];
}

export interface SettingsProps {
  page: SettingsNavId;
  query: string;
  theme: 'light' | 'dark';
  sections: SettingsSectionData[];
  providers: ProviderCardData[];
  providerForm: ProviderFormState;
  defaultModelLabel: string | null;
  vendorEmpty: string;
  catalogInfo: string;
  demo: boolean;
  /** Production: disables the demo add-provider form (models are pi-managed). */
  disableProviderForm?: boolean;
  /**
   * Production: real model catalog from the local pi configuration, rendered
   * instead of the static provider placeholders.
   */
  modelCatalogSection?: ReactNode;
  /** Provider count shown in the section badge (pi catalog mode). */
  catalogProviderCount?: number;
  /** Production: extra real-content block rendered inside the Info pane. */
  infoExtra?: ReactNode;
  pageContent?: ReactNode;
  labels: SettingsLabels;
  onBack: () => void;
  onSearch: (q: string) => void;
  onSelectPage: (id: SettingsNavId) => void;
  onRowControl: (rowId: string, value: string | number | boolean) => void;
  onSetProviderForm: (patch: Partial<ProviderFormState>) => void;
  onLoginProvider?: (id:string) => void;
  onSelectDefaultModel?: (provider:string,model:string) => void;
  catalogWarning?: string;
  onSaveProvider: () => void;
  onSaveProviderModel?: (providerId: string, model: import("../../shared/pi").PiCatalogModel, originalId?: string) => Promise<void>;
  onEditProvider: (id: string) => void;
  onDeleteProvider: (id: string) => void;
  onToggleProvider: (id: string) => void;
  onMakeDefault: (id: string) => void;
  onRefreshCatalog: () => void;
}

export interface ProviderFormState {
  saving?: boolean;
  open: boolean;
  editingId: string | null;
  name: string;
  baseUrl: string;
  apiKey: string;
  modelLine: string;
  models?: import("../../shared/pi").PiCatalogModel[];
  error?: string;
}

export interface SettingsLabels {
  backToApp: string;
  searchSettings: string;
  // nav
  general: string; ai: string; shortcuts: string;
  instructions: string; models: string; skills: string; mcp: string;
  extensions: string; subagents: string;
  import: string; projects: string; info: string;
  // section titles
  appearance: string; network: string; defaults: string; aiProviders: string;
  vendorAccounts: string;
  // general rows
  theme: string; themeDesc: string; language: string; languageDesc: string;
  font: string; fontDesc: string; fontSize: string; fontSizeDesc: string;
  proxy: string; proxyDesc: string;
  // models
  modelConfiguration: string;
  defaultModel: string; noDefault: string; change: string;
  addProvider: string; makeDefault: string; defaultBadge: string;
  addAccount: string; noVendor: string; refreshCatalog: string;
  providerFormTitle: string; providerFormEdit: string;
  edit: string; delete: string; authManagedHint: string; modelsListTitle: string;
  providerName: string; providerBaseUrl: string; providerApiKey: string;
  providerModels: string; providerModelsHint: string;
  save: string; cancel: string; nameRequired: string; modelRequired: string;
  demoConfigNote: string;
  // resource panes
  emptyGeneric: string;
  emptyGenericHint: string;
  // info
  about: string;
  version: string;
  runtime: string;
  demoEnv: string;
}

// ---------------------------------------------------------------------------
// Overlays: global search & notifications (U06)
// ---------------------------------------------------------------------------

export interface SearchItem {
  id: string;
  kind: 'session' | 'message' | 'page' | 'setting' | 'command' | 'action';
  title: string;
  source: string;
}

export interface GlobalSearchProps {
  open: boolean;
  query: string;
  items: SearchItem[];
  demo: boolean;
  labels: SearchLabels;
  onQuery: (q: string) => void;
  onClose: () => void;
  onSelect: (item: SearchItem) => void;
}

export interface SearchLabels {
  placeholder: string;
  newTask: string;
  today: string;
  noResults: string;
}

export interface NotificationItem {
  id: string;
  kind: 'info' | 'success' | 'error' | 'request';
  title: string;
  body?: string;
  time: string;
  read: boolean;
}

export interface NotificationsProps {
  open: boolean;
  items: NotificationItem[];
  demo: boolean;
  labels: NotificationsLabels;
  onClose: () => void;
  onMarkAllRead: () => void;
  onSelect: (item: NotificationItem) => void;
}

export interface NotificationsLabels {
  title: string;
  markAllRead: string;
  empty: string;
  request: string;
  demoNote: string;
}

// ---------------------------------------------------------------------------
// Preview container (U07)
// ---------------------------------------------------------------------------

export type PreviewView = 'home' | 'chat' | 'plugins' | 'settings';

export interface PreviewFrameLabels {
  badge: string;
  reset: string;
  resetConfirm: string;
}
