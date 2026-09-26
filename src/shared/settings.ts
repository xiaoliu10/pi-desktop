import type { DesktopProject, ProjectUpdate, WorktreeInput } from './projects';
import type { AccessMode } from './access-mode';
import type { ThinkingLevel } from './composer';
export type ResourceKind = 'instructions' | 'skills' | 'prompts' | 'extensions' | 'subagents';
export type ShortcutAction = 'search' | 'newSession' | 'settings' | 'workbench' | 'sidebar' | 'stop';
/** 新建任务页底部的固定 agent 快捷入口：点击预填提示词，可直接绑定一个 pi skill。 */
export interface AgentPreset { id: string; label: string; icon: string; /** 绑定的技能名（对应 ~/.pi/agent/skills 下的技能）。 */ skill?: string; prompt: string }
export const DEFAULT_AGENT_PRESETS: AgentPreset[] = [
  { id: 'weekly-report', label: '周报总结', icon: 'file', prompt: '总结本周工作，生成一份周报：浏览本周的会话记录和 git 提交，按项目归纳进展、遇到的问题和下周计划，输出 Markdown 周报。' },
  { id: 'fix-error', label: '报错修复', icon: 'warning', prompt: '排查并修复当前项目的报错：先复现并定位根因，给出最小修复，补上回归测试后运行验证。' },
  { id: 'ppt', label: 'PPT 制作', icon: 'panel', prompt: '帮我制作一份 PPT：主题和内容由我补充，先给出结构大纲，确认后再产出，风格默认科技感、深色背景。' },
  { id: 'idle-task', label: '闲时任务', icon: 'calendar-clock', prompt: '低优先级任务，不着急，按下面的描述慢慢做：' },
];
export interface DesktopPreferences {
  behavior: 'steer' | 'followUp';
  permission: AccessMode;
  shortcuts: Record<ShortcutAction, string>;
  projects: DesktopProject[];
  hiddenProjects?: string[];
  /** Desktop-only 每会话访问模式记忆：同一 session 重进后恢复上次选择。 */
  sessionAccessModes?: Record<string, AccessMode>;
  /** Desktop-only display names per session key; the CLI files stay untouched. */
  sessionRenames?: Record<string, string>;
  /** 定时扫描最近打开过的工作区，将已完成、未置顶且超过保留期的任务自动归档。 */
  autoArchive?: boolean;
  /** 归档保留时长（天）：任务最后更新时间早于该时长才进入自动归档候选。 */
  archiveRetentionDays?: number;
  /** 自动删除超期归档任务（永久删除，不进废纸篓）；默认关闭。 */
  autoDeleteArchived?: boolean;
  /** 归档任务自动删除保留时长（天）：归档时间早于该时长才进入自动删除候选。 */
  autoDeleteArchivedDays?: number;
  /** 用户在输入框选择的思考等级，跨会话固化。 */
  defaultThinkingLevel?: ThinkingLevel;
  /** 固定 agent 快捷入口；缺省用 DEFAULT_AGENT_PRESETS。 */
  agentPresets?: AgentPreset[];
  /** 顶栏「打开方式」记住的外部应用 id（externalApps() 白名单之一）。 */
  openWithApp?: string;
  /** 自动项目记忆总结与召回（Desktop 记忆衔接层）。 */
  memoryAssist?: boolean;
  /** 已从子代理目录清理掉的 callId（按会话持久化，避免重进又出现）。 */
  subagentDismissed?: Record<string, string[]>;
}
export const ARCHIVE_RETENTION_DAYS = [7, 30, 90] as const;
export const DEFAULT_ARCHIVE_RETENTION_DAYS = 30;
export const AUTO_DELETE_ARCHIVED_DAYS = [7, 30, 90, 180, 365] as const;
export const DEFAULT_AUTO_DELETE_ARCHIVED_DAYS = 30;
export const DEFAULT_SHORTCUTS: Record<ShortcutAction, string> = { search: 'Mod+K', newSession: 'Mod+Shift+N', settings: 'Mod+,', workbench: 'Mod+Shift+R', sidebar: 'Mod+B', stop: 'Mod+Shift+X' };
export interface EditableResource {
  id: string; name: string; path: string; scope: 'user' | 'project'; kind: ResourceKind;
  status: string; detail: string; editable: boolean;
}
export interface ResourceDocument { id: string; text: string; revision: string }
export interface McpServerRow { id: string; name: string; scope: 'user' | 'project'; transport: string; target: string; enabled: boolean; path: string; revision: string; /** Import source (claude-code/cursor/…) when the server came from mcp.json `imports`, not direct mcpServers. */ source?: string }
export interface SettingsSnapshot {
  preferences: DesktopPreferences;
  ai: { defaultProvider: string; defaultModel: string; defaultThinkingLevel: string; autoCompact: boolean; retry: boolean; revision: string };
  resources: EditableResource[];
  mcp: McpServerRow[];
  mcpRevisions: Record<string, string>;
  diagnostics: string[];
  projects: Array<{ path: string; name: string; registered: boolean; exists: boolean; sessions: number }>;
  /** Desktop 每次连接经 -e 装载的内置扩展（存在的文件）。 */
  loadedExtensions: string[];
}
export interface SettingsApi {
  settingsSnapshot(cwd?: string): Promise<SettingsSnapshot>;
  saveDesktopSettings(patch: Partial<Pick<DesktopPreferences, 'behavior' | 'permission' | 'shortcuts' | 'sessionRenames' | 'sessionAccessModes' | 'autoArchive' | 'archiveRetentionDays' | 'autoDeleteArchived' | 'autoDeleteArchivedDays' | 'defaultThinkingLevel' | 'openWithApp' | 'memoryAssist' | 'subagentDismissed'>>): Promise<void>;
  saveAiSettings(value: SettingsSnapshot['ai']): Promise<void>;
  resourceRead(id: string, cwd?: string): Promise<ResourceDocument>;
  resourceSave(input: { id: string; text: string; revision: string; cwd?: string }): Promise<void>;
  resourceCreate(input: { kind: ResourceKind; scope: 'user' | 'project'; name: string; text: string; cwd?: string }): Promise<void>;
  resourceToggle(id: string, enabled: boolean, cwd?: string): Promise<void>;
  revealResource(id: string, cwd?: string): Promise<void>;
  mcpSave(input: { name: string; scope: 'user' | 'project'; config?: string; enabled?: boolean; remove?: boolean; revision: string; cwd?: string }): Promise<void>;
  mcpTest(id: string, cwd?: string): Promise<{ tools: string[] }>;
  projectSave(value: ProjectUpdate): Promise<void>;
  projectReveal(cwd: string): Promise<void>;
  projectWorktree(value: WorktreeInput): Promise<DesktopProject>;
  projectArchive(cwd: string): Promise<string[]>;
  importSession(): Promise<{ key: string; duplicate: boolean } | null>;
  runSubagent(id: string, cwd: string, task: string, parentKey?: string): Promise<import('./pi').PiRun>;
}
export function shortcutMatches(event: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }, binding: string): boolean {
  const parts = binding.toLowerCase().split('+'), key = parts.pop();
  return event.key.toLowerCase() === key && (event.metaKey || event.ctrlKey) === parts.includes('mod') && event.shiftKey === parts.includes('shift') && event.altKey === parts.includes('alt');
}
export function validShortcut(value: string): boolean { return /^Mod\+(?:Shift\+)?(?:Alt\+)?(?:[A-Za-z0-9,./]|F(?:[1-9]|1[0-2]))$/.test(value); }
