/**
 * Demo fixtures for the UI replica preview (U01/U07).
 *
 * Every ID is stable so screenshots and interaction tests are reproducible.
 * All content is explicitly demo data; the preview never reads or writes
 * user files, ~/.pi, or any real store. Persistence uses the
 * `pireplica-preview:` localStorage prefix only.
 */

import type {
  ChatMessage,
  DemoFileDiff,
  MarketplaceCardData,
  ModelGroup,
  NotificationItem,
  PluginRowData,
  ProjectNavItem,
  ProviderCardData,
  SearchItem,
  SessionNavItem,
  SettingsNavSection,
  SlashCommand,
  DemoFileNode,
} from '../replica/contracts';
import type { ReplicaLang } from '../replica/i18n';

export const PREVIEW_STORAGE_PREFIX = 'pireplica-preview:';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function ago(ms: number): number {
  return Date.now() - ms;
}

// ---------------------------------------------------------------------------
// Sessions & projects
// ---------------------------------------------------------------------------

export interface DemoProject {
  id: string;
  name: string;
  path: string;
}

export const demoProjects = (lang: ReplicaLang): DemoProject[] => [
  { id: 'proj-apps', name: 'apps', path: '/Users/demo/work/apps' },
  {
    id: 'proj-web',
    name: 'web-site',
    path: '/Users/demo/work/web-site',
  },
  {
    id: 'proj-infra',
    name: lang === 'zh' ? '运维脚本' : 'infra-scripts',
    path: '/Users/demo/work/infra-scripts',
  },
];

export const demoTemporarySessions = (lang: ReplicaLang): SessionNavItem[] => [
  { id: 'sess-layout', title: lang === 'zh' ? '制作台的布局重新设计，需要现代化简约' : 'Redesign the workbench layout, keep it minimal', updatedAt: ago(52 * MIN), source: 'desktop' },
  { id: 'sess-plugin-ui', title: lang === 'zh' ? '重新设计设置页面插件板块手机端布局' : 'Redesign the settings plugin section for narrow screens', updatedAt: ago(3 * HOUR), source: 'desktop' },
  { id: 'sess-uninstall', title: lang === 'zh' ? '帮我彻底卸载比特浏览器' : 'Help me fully uninstall BitBrowser', updatedAt: ago(26 * HOUR), source: 'desktop' },
  // pi CLI sessions: read-only observation, distinct source
  { id: 'sess-cli-refactor', title: lang === 'zh' ? '重构会话索引模块（来自 pi CLI）' : 'Refactor the session indexer (from pi CLI)', updatedAt: ago(35 * MIN), source: 'pi-cli', syncedAt: lang === 'zh' ? '2 分钟前' : '2 min ago', canContinue: true, busy: true },
  { id: 'sess-cli-tests', title: lang === 'zh' ? '修复 CLI 集成测试抖动（来自 pi CLI）' : 'Fix flaky CLI integration tests (from pi CLI)', updatedAt: ago(5 * HOUR), source: 'pi-cli', syncedAt: lang === 'zh' ? '40 分钟前' : '40 min ago', canContinue: true },
];

export const demoProjectSessions = (lang: ReplicaLang): Record<string, SessionNavItem[]> => ({
  'proj-apps': [
    { id: 'sess-config', title: lang === 'zh' ? '帮我配置一下这个项目并启动' : 'Help me configure this project and start it', updatedAt: ago(28 * HOUR), source: 'desktop' },
    { id: 'sess-proc', title: lang === 'zh' ? '终止进程里面有一个注册机的' : 'Kill the process with the keygen', updatedAt: ago(2 * DAY), source: 'desktop' },
  ],
  'proj-web': [],
  'proj-infra': [
    { id: 'sess-cli-deploy', title: lang === 'zh' ? '部署脚本灰度发布（来自 pi CLI）' : 'Canary deploy script (from pi CLI)', updatedAt: ago(9 * HOUR), source: 'pi-cli', syncedAt: lang === 'zh' ? '1 小时前' : '1 h ago', canContinue: true },
  ],
});

// ---------------------------------------------------------------------------
// Conversation for the long session (sess-plugin-ui)
// ---------------------------------------------------------------------------

const diffGroups: DemoFileDiff = {
  path: 'src/sidebar-session-groups.ts',
  created: false,
  additions: 6,
  deletions: 2,
  lines: [
    { type: ' ', text: 'export function groupSessions(sessions: Session[]) {' },
    { type: '-', text: "  const label = 'Recent';" },
    { type: '-', text: '  return [{ label, sessions }];' },
    { type: '+', text: '  const groups = new Map<string, Session[]>();' },
    { type: '+', text: '  for (const s of sessions) {' },
    { type: '+', text: '    const key = s.projectPath ?? temporaryLabel;' },
    { type: '+', text: '    push(groups, key, s);' },
    { type: '+', text: '  }' },
    { type: '+', text: '  return [...groups].map(([label, items]) => ({ label, sessions: items }));' },
    { type: ' ', text: '}' },
  ],
};

const diffTokens: DemoFileDiff = {
  path: 'src/theme-tokens.css',
  created: false,
  additions: 2,
  deletions: 1,
  lines: [
    { type: ' ', text: ':root {' },
    { type: '-', text: '  --text-sm: 13px;' },
    { type: '+', text: '  --text-2xs: 11px;' },
    { type: ' ', text: '  --text-md: 14px;' },
    { type: '+', text: '  --group-gap: 18px;' },
    { type: ' ', text: '}' },
  ],
};

export const demoLongConversation = (lang: ReplicaLang): ChatMessage[] => [
  {
    id: 'm1',
    role: 'user',
    parts: [{ kind: 'text', id: 'm1t', text: lang === 'zh' ? '重新设计设置页面插件板块，手机端布局也要考虑。' : 'Redesign the settings plugin section, keep narrow screens in mind.' }],
  },
  {
    id: 'm2',
    role: 'assistant',
    simulated: true,
    model: 'gpt-5.6',
    parts: [
      { kind: 'text', id: 'm2t', text: lang === 'zh' ? '好的，我先看一下现有设置页的结构和插件列表的渲染方式。' : 'Sure — let me first look at the current settings structure and how the plugin list renders.' },
      {
        kind: 'tool',
        id: 'm2tool1',
        tool: 'read_file',
        summary: 'src/settings/PluginSection.tsx',
        status: 'done',
        detailLines: [
          'export function PluginSection({ plugins }: Props) {',
          '  const [tab, setTab] = useState<"installed" | "market">("installed");',
          '  // …62 more lines',
        ],
      },
      {
        kind: 'tool',
        id: 'm2tool2',
        tool: 'grep',
        summary: 'PluginRow in src/**',
        status: 'done',
        detailLines: [
          'src/settings/PluginSection.tsx:41: <PluginRow …>',
          'src/settings/PluginRow.tsx:12: export function PluginRow(…)',
        ],
      },
      { kind: 'text', id: 'm2t2', text: lang === 'zh' ? '列表行目前是固定高度，状态分组缺失。我会引入 NEEDS ATTENTION / UPDATES / ACTIVE / OFF 四个分组，并压缩行高。' : 'Rows have a fixed height and no status groups. I will introduce NEEDS ATTENTION / UPDATES / ACTIVE / OFF groups and tighten the rows.' },
      {
        kind: 'tool',
        id: 'm2tool3',
        tool: 'edit_file',
        summary: 'src/sidebar-session-groups.ts',
        status: 'done',
        diff: diffGroups,
      },
    ],
  },
  {
    id: 'm3',
    role: 'user',
    parts: [{ kind: 'text', id: 'm3t', text: lang === 'zh' ? '顺便把侧边栏最近会话按项目分组' : 'Also group recent sidebar sessions by project' }],
  },
  {
    id: 'm4',
    role: 'assistant',
    simulated: true,
    model: 'gpt-5.6',
    parts: [
      { kind: 'text', id: 'm4t', text: lang === 'zh' ? '已按项目路径分组：每组显示项目名与最近活动时间，未关联项目的会话归入“临时会话”。分组逻辑在 `sidebar-session-groups.ts`。' : 'Grouped by project path: each group shows the project name and latest activity; sessions without a project fall into “Temporary chats”. Logic lives in `sidebar-session-groups.ts`.' },
      { kind: 'notice', id: 'm4n', text: lang === 'zh' ? '模拟运行：以下命令不会真正执行' : 'Simulated run: the command below is not executed' },
      {
        kind: 'tool',
        id: 'm4tool1',
        tool: 'run_command',
        summary: 'pnpm typecheck',
        status: 'done',
        detailLines: ['$ pnpm typecheck', 'tsc completed with 0 errors'],
      },
      { kind: 'text', id: 'm4t2', text: lang === 'zh' ? '`pnpm typecheck` 与样式令牌检查均通过，无回归。' : '`pnpm typecheck` and the token lint pass, no regressions.' },
    ],
  },
  {
    id: 'm5',
    role: 'user',
    parts: [{ kind: 'text', id: 'm5t', text: lang === 'zh' ? '分组标题的字号再小一点' : 'Make the group titles smaller' }],
  },
  {
    id: 'm6',
    role: 'assistant',
    simulated: true,
    model: 'gpt-5.6',
    parts: [
      { kind: 'text', id: 'm6t', text: lang === 'zh' ? '已把分组标题从 `--text-sm` 调整为 `--text-2xs`，同时收紧了上下间距，现在与 PI-Desktop 的密度一致。' : 'Changed the group title from `--text-sm` to `--text-2xs` and tightened spacing to match the PI-Desktop density.' },
      {
        kind: 'tool',
        id: 'm6tool1',
        tool: 'edit_file',
        summary: 'src/theme-tokens.css',
        status: 'done',
        diff: diffTokens,
      },
    ],
  },
  {
    id: 'm7',
    role: 'user',
    parts: [{ kind: 'text', id: 'm7t', text: lang === 'zh' ? '最后跑一遍检查' : 'Run the checks one last time' }],
  },
  {
    id: 'm8',
    role: 'assistant',
    simulated: true,
    model: 'gpt-5.6',
    parts: [
      {
        kind: 'error',
        id: 'm8e',
        message: lang === 'zh' ? '模拟错误：flaky-test.spec.ts 第 42 行断言超时（仅演示错误展示）' : 'Simulated error: flaky-test.spec.ts:42 assertion timeout (demo of error rendering)',
      },
      { kind: 'text', id: 'm8t', text: lang === 'zh' ? '其余检查通过；上面的失败仅用于演示错误样式，并非真实测试结果。' : 'All other checks pass; the failure above only demonstrates error styling, it is not a real test result.' },
    ],
  },
];

export const demoSmallConversation = (lang: ReplicaLang): ChatMessage[] => [
  {
    id: 'c1',
    role: 'user',
    parts: [{ kind: 'text', id: 'c1t', text: lang === 'zh' ? '同步代码' : 'Sync the code' }],
  },
  {
    id: 'c2',
    role: 'assistant',
    simulated: true,
    model: 'claude-opus-5',
    parts: [{ kind: 'text', id: 'c2t', text: lang === 'zh' ? '已同步完毕。接下来可以在设置里添加模型提供商并保存 API 密钥，然后打开一个项目文件夹就能开始对话了。' : 'All synced. Next you can add a model provider in Settings and save the API key, then open a project folder to start chatting.' }],
  },
];

export const demoMessagesBySession = (lang: ReplicaLang): Record<string, ChatMessage[]> => ({
  'sess-plugin-ui': demoLongConversation(lang),
  'sess-layout': demoSmallConversation(lang),
});

// ---------------------------------------------------------------------------
// Composer data
// ---------------------------------------------------------------------------

export const demoModelGroups: ModelGroup[] = [
  {
    provider: 'OpenAI',
    models: [
      { id: 'gpt-5.6', name: 'GPT-5.6', detail: 'gpt-5.6' },
      { id: 'gpt-5.6-mini', name: 'GPT-5.6 mini', detail: 'gpt-5.6-mini' },
    ],
  },
  {
    provider: 'Anthropic',
    models: [
      { id: 'claude-opus-5', name: 'Claude Opus 5', detail: 'claude-opus-5' },
      { id: 'claude-fable-5', name: 'Claude Fable 5', detail: 'claude-fable-5-1' },
    ],
  },
  {
    provider: 'Ollama (local)',
    models: [{ id: 'qwen4-32b', name: 'Qwen4 32B', detail: 'qwen4:32b' }],
  },
];

export const demoSlashCommands = (lang: ReplicaLang): SlashCommand[] => [
  { name: '/plan', description: lang === 'zh' ? '进入计划模式（pi 扩展）' : 'Enter plan mode (pi extension)' },
  { name: '/todos', description: lang === 'zh' ? '查看待办列表' : 'Show the todo list' },
  { name: '/review', description: lang === 'zh' ? '审查当前变更' : 'Review current changes' },
  { name: '/compact', description: lang === 'zh' ? '压缩上下文' : 'Compact the context' },
];

export const demoFiles = (lang: ReplicaLang): string[] =>
  lang === 'zh'
    ? [
        'src/sidebar-session-groups.ts',
        'src/settings/PluginSection.tsx',
        'src/settings/PluginRow.tsx',
        'src/theme-tokens.css',
        'docs/ui-replica-spec.md',
      ]
    : [
        'src/sidebar-session-groups.ts',
        'src/settings/PluginSection.tsx',
        'src/settings/PluginRow.tsx',
        'src/theme-tokens.css',
        'docs/ui-replica-spec.md',
      ];

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

export const demoInstalledPlugins = (lang: ReplicaLang): PluginRowData[] => [
  {
    id: 'pl-deploy',
    name: 'Deploy Preview',
    packageId: 'pi.deploy-preview',
    version: '0.4.1',
    status: 'attention',
    scope: 'everywhere',
    error: lang === 'zh' ? 'Manifest 声明了 net.fetch 但缺少授权。' : 'Manifest declares net.fetch but the grant is missing.',
    details: [
      lang === 'zh' ? '需要用户在扩展设置中确认网络授权后才能加载。' : 'The extension needs a network grant confirmed in its settings before it can load.',
      lang === 'zh' ? '来源：GitHub (official) · 上次加载：失败' : 'Source: GitHub (official) · last load: failed',
    ],
    latestVersion: '0.4.1',
  },
  {
    id: 'pl-git',
    name: 'Git Insights',
    packageId: 'pi.git-insights',
    version: '1.4.2',
    status: 'updatable',
    scope: 'everywhere',
    details: [
      lang === 'zh' ? '把仓库活动汇总到审查面板。' : 'Summarizes repository activity into a review panel.',
      lang === 'zh' ? '可更新到 v1.5.0（示例数据）。' : 'Update to v1.5.0 available (sample data).',
    ],
    latestVersion: '1.5.0',
  },
  {
    id: 'pl-markdown',
    name: 'Markdown Tools',
    packageId: 'pi.markdown-tools',
    version: '0.9.0',
    status: 'active',
    scope: 'everywhere',
    details: [lang === 'zh' ? '按需格式化表格、规范标题层级。' : 'Formats tables and normalizes headings on demand.'],
    latestVersion: '0.9.0',
  },
  {
    id: 'pl-scratchpad',
    name: 'Scratchpad',
    packageId: 'pi.scratchpad',
    version: 'dev',
    status: 'off',
    scope: 'project',
    badge: 'Local',
    details: [lang === 'zh' ? '本地目录加载的扩展，仅在此项目生效。' : 'Loaded from a local directory, scoped to this project.'],
    latestVersion: 'dev',
  },
];

export const demoMarketplaceCards = (lang: ReplicaLang): MarketplaceCardData[] => [
  {
    id: 'mp-git',
    name: 'Git Insights',
    verified: true,
    publisher: 'Pi Labs',
    version: '1.5.0',
    installs: 12840,
    description: lang === 'zh' ? '把仓库活动汇总成审查面板里的可读摘要。' : 'Summarizes repository activity into a review panel.',
    permissions: ['edit', 'read', 'panel'],
    installedVersion: '1.4.2',
    updateAvailable: true,
    published: true,
    tags: ['editing'],
  },
  {
    id: 'mp-markdown',
    name: 'Markdown Tools',
    verified: false,
    publisher: lang === 'zh' ? '社区' : 'Community',
    version: '0.9.0',
    installs: 3210,
    description: lang === 'zh' ? '按需格式化表格并规范标题层级。' : 'Formats tables and normalizes headings on demand.',
    permissions: ['clipboard'],
    installedVersion: '0.9.0',
    published: true,
    tags: ['editing', 'productivity'],
  },
  {
    id: 'mp-deploy',
    name: 'Deploy Preview',
    verified: true,
    publisher: 'Pi Labs',
    version: '0.4.1',
    installs: 980,
    description: lang === 'zh' ? '为当前分支构建预览部署并在会话中给出链接。' : 'Builds a preview deployment for the current branch and links it in chat.',
    permissions: ['network', 'panel'],
    installedVersion: '0.4.1',
    published: true,
    tags: ['productivity'],
  },
  {
    id: 'mp-sql',
    name: 'SQL Explorer',
    verified: false,
    publisher: lang === 'zh' ? '数据工具组' : 'Data Tools',
    version: '2.1.0',
    installs: 5602,
    description: lang === 'zh' ? '浏览本地数据库并把查询结果粘贴进对话。' : 'Browse local databases and paste query results into chat.',
    permissions: ['spawn', 'read'],
    published: false,
    tags: ['data'],
  },
];

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const demoSettingsNav = (lang: ReplicaLang): SettingsNavSection[] => [
  {
    label: lang === 'zh' ? '基础设置' : 'General',
    items: [
      { id: 'general', label: lang === 'zh' ? '通用' : 'General', icon: 'sliders' },
      { id: 'ai', label: 'AI', icon: 'sparkle' },
      { id: 'shortcuts', label: lang === 'zh' ? '快捷键' : 'Shortcuts', icon: 'keyboard' },
    ],
  },
  {
    label: 'Agent',
    items: [
      { id: 'instructions', label: lang === 'zh' ? '指令' : 'Instructions', icon: 'instructions' },
      { id: 'models', label: lang === 'zh' ? '模型' : 'Models', icon: 'bot' },
      { id: 'skills', label: lang === 'zh' ? '技能' : 'Skills', icon: 'book' },
      { id: 'mcp', label: 'MCP', icon: 'stack' },
      { id: 'extensions', label: lang === 'zh' ? '扩展' : 'Extensions', icon: 'plug' },
      { id: 'subagents', label: lang === 'zh' ? '子代理' : 'Subagents', icon: 'box' },
    ],
  },
  {
    label: lang === 'zh' ? '工作区' : 'Workspace',
    items: [
      { id: 'import', label: lang === 'zh' ? '导入' : 'Import', icon: 'download' },
      { id: 'projects', label: lang === 'zh' ? '项目' : 'Projects', icon: 'archive' },
    ],
  },
  {
    label: lang === 'zh' ? '系统' : 'System',
    items: [{ id: 'info', label: lang === 'zh' ? '关于' : 'Info', icon: 'info' }],
  },
];

export const demoProviders = (): ProviderCardData[] => [
  { id: 'prov-oj', name: 'OJ Gateway', baseUrl: 'api.oj.ink', modelCount: 1, isDefault: false, enabled: true, source: 'models.json', models: [{ id: 'gpt-5.6', name: 'GPT-5.6' }] },
];

// ---------------------------------------------------------------------------
// Workbench & notifications & search
// ---------------------------------------------------------------------------

export const demoWorkbenchDiffs: DemoFileDiff[] = [diffGroups, diffTokens];

export const demoWorkbenchFiles = (): DemoFileNode[] => [
  { path: 'src/sidebar-session-groups.ts', excerpt: ['export function groupSessions(sessions: Session[]) {', '  const groups = new Map<string, Session[]>();', '  // …', '}'] },
  { path: 'src/theme-tokens.css', excerpt: [':root {', '  --text-2xs: 11px;', '  --group-gap: 18px;', '}'] },
  { path: 'src/settings/PluginSection.tsx', excerpt: ['export function PluginSection({ plugins }: Props) {', '  const grouped = groupByStatus(plugins);', '  // …', '}'] },
];

export const demoNotifications = (lang: ReplicaLang): NotificationItem[] => [
  {
    id: 'nt-1',
    kind: 'request',
    title: lang === 'zh' ? 'Deploy Preview 请求网络授权' : 'Deploy Preview requests a network grant',
    body: lang === 'zh' ? '示例请求：允许 net.fetch 到 deploy.example.com？' : 'Sample request: allow net.fetch to deploy.example.com?',
    time: lang === 'zh' ? '3 分钟前' : '3 min ago',
    read: false,
  },
  {
    id: 'nt-2',
    kind: 'success',
    title: lang === 'zh' ? '类型检查通过' : 'Typecheck passed',
    body: lang === 'zh' ? '（模拟通知）pnpm typecheck 无错误。' : '(demo) pnpm typecheck finished with 0 errors.',
    time: lang === 'zh' ? '22 分钟前' : '22 min ago',
    read: false,
  },
  {
    id: 'nt-3',
    kind: 'info',
    title: lang === 'zh' ? 'Git Insights 有可用更新' : 'Git Insights update available',
    body: lang === 'zh' ? 'v1.4.2 → v1.5.0（示例数据）。' : 'v1.4.2 → v1.5.0 (sample data).',
    time: lang === 'zh' ? '1 小时前' : '1 h ago',
    read: true,
  },
];

export const demoSearchItems = (lang: ReplicaLang): SearchItem[] => [
  { id: 'sr-1', kind: 'session', title: lang === 'zh' ? '制作台的布局重新设计，需要现代化简约' : 'Redesign the workbench layout', source: lang === 'zh' ? '临时会话' : 'Temporary chats' },
  { id: 'sr-2', kind: 'session', title: lang === 'zh' ? '重新设计设置页面插件板块手机端布局' : 'Settings plugin section for narrow screens', source: lang === 'zh' ? '临时会话' : 'Temporary chats' },
  { id: 'sr-3', kind: 'session', title: lang === 'zh' ? '帮我彻底卸载比特浏览器' : 'Fully uninstall BitBrowser', source: lang === 'zh' ? '临时会话' : 'Temporary chats' },
  { id: 'sr-4', kind: 'session', title: lang === 'zh' ? '帮我配置一下这个项目并启动' : 'Configure this project and start it', source: 'apps' },
  { id: 'sr-5', kind: 'message', title: lang === 'zh' ? '…分组标题的字号再小一点' : '…make the group titles smaller', source: lang === 'zh' ? '消息 · 重新设计设置页面插件板块…' : 'Message · Settings plugin section…' },
  { id: 'sr-6', kind: 'page', title: lang === 'zh' ? '扩展' : 'Extensions', source: lang === 'zh' ? '页面' : 'Page' },
  { id: 'sr-7', kind: 'setting', title: lang === 'zh' ? '主题' : 'Theme', source: lang === 'zh' ? '设置 · 通用' : 'Setting · General' },
  { id: 'sr-8', kind: 'command', title: '/plan', source: lang === 'zh' ? '命令' : 'Command' },
];

// ---------------------------------------------------------------------------
// Persistence (preview-only, explicit prefix; never touched by the real app)
// ---------------------------------------------------------------------------

export interface PersistedPreview {
  version: 1;
  savedAt: number;
}

export function loadPreviewStore<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(PREVIEW_STORAGE_PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function savePreviewStore<T>(key: string, value: T): void {
  try {
    window.localStorage.setItem(PREVIEW_STORAGE_PREFIX + key, JSON.stringify(value));
  } catch {
    /* storage unavailable (private mode) — preview still works in memory */
  }
}

export function resetPreviewStore(): void {
  try {
    const doomed: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith(PREVIEW_STORAGE_PREFIX)) doomed.push(k);
    }
    doomed.forEach((k) => window.localStorage.removeItem(k));
  } catch {
    /* ignore */
  }
}
