/**
 * Demo state adapter for the UI replica preview (U07).
 *
 * Single source of preview state. Pages stay contract-driven (see
 * src/renderer/replica/contracts.ts); this adapter implements their
 * callbacks with demo data only. It never touches window.pi, the main
 * process, or the prototype store.
 *
 * Sending a prompt runs a clearly-labeled simulated reply so the UI can be
 * exercised without any model. User actions (renames, toggles, provider
 * edits) persist to the `pireplica-preview:` localStorage prefix and can be
 * wiped with reset().
 */

import { create } from 'zustand';
import type {
  AgentMode,
  ChatMessage,
  MarketplaceCardData,
  NotificationItem,
  PermissionChoice,
  PluginRowData,
  ProjectNavItem,
  ProviderCardData,
  ProviderFormState,
  ReasoningLevel,
  SessionNavItem,
  SettingsNavId,
  WorkbenchTab,
} from '../replica/contracts';
import type { ReplicaLang } from '../replica/i18n';
import {
  demoInstalledPlugins,
  demoMarketplaceCards,
  demoMessagesBySession,
  demoNotifications,
  demoProjectSessions,
  demoProjects,
  demoProviders,
  demoTemporarySessions,
  loadPreviewStore,
  resetPreviewStore,
  savePreviewStore,
} from './fixtures';
import type { PreviewView } from '../replica/contracts';

export interface DemoState {
  // chrome
  lang: ReplicaLang;
  theme: 'light' | 'dark';
  fontScale: number; // percent, 85–125
  font: string;
  proxy: string;
  view: PreviewView;
  settingsPage: SettingsNavId;
  sidebarCollapsed: boolean;
  expandedProjects: string[];

  // navigation & sessions
  activeSessionId: string | null;
  renames: Record<string, string>;
  newSessionCounter: number;

  // conversation
  messages: Record<string, ChatMessage[]>;
  running: boolean;
  queued: number;

  // composer
  modelId: string;
  reasoning: ReasoningLevel;
  agentMode: AgentMode;
  permissionMode: PermissionChoice;

  // plugins
  plugins: PluginRowData[];
  marketplace: MarketplaceCardData[];
  pluginTab: 'installed' | 'marketplace';
  pluginSearch: string;
  pluginTag: string;
  marketplaceSource: string;
  pluginUpdatesReady: number;

  // workbench
  workbenchOpen: boolean;
  workbenchTab: WorkbenchTab;
  selectedFile: string | null;

  // overlays
  searchOpen: boolean;
  searchQuery: string;
  notificationsOpen: boolean;
  notifications: NotificationItem[];

  // settings
  providers: ProviderCardData[];
  providerForm: ProviderFormState;
  defaultModelLabel: string | null;

  // transient
  resetCounter: number;
}

export interface DemoActions {
  navigate: (view: PreviewView) => void;
  openSettings: (page?: SettingsNavId) => void;
  backToApp: () => void;
  toggleSidebar: () => void;
  toggleProject: (id: string) => void;

  selectSession: (id: string) => void;
  newSession: () => void;
  renameSession: (id: string) => void;

  send: (text: string) => void;
  stop: () => void;

  setLang: (lang: ReplicaLang) => void;
  setTheme: (theme: 'light' | 'dark') => void;
  setFontScale: (pct: number) => void;
  setFont: (font: string) => void;
  setProxy: (mode: string) => void;

  setComposer: (patch: Partial<Pick<DemoState, 'modelId' | 'reasoning' | 'agentMode' | 'permissionMode'>>) => void;

  // plugins
  setPluginTab: (tab: 'installed' | 'marketplace') => void;
  setPluginSearch: (q: string) => void;
  setPluginTag: (tag: string) => void;
  setMarketplaceSource: (s: string) => void;
  togglePlugin: (id: string) => void;
  updatePlugin: (id: string) => void;
  installPlugin: (id: string) => void;
  applyUpdates: () => void;
  refreshMarketplace: () => void;

  // workbench
  toggleWorkbench: () => void;
  selectWorkbenchTab: (tab: WorkbenchTab) => void;
  selectFile: (path: string | null) => void;

  // overlays
  setSearchOpen: (open: boolean) => void;
  setSearchQuery: (q: string) => void;
  toggleNotifications: () => void;
  markAllRead: () => void;

  // settings
  selectSettingsPage: (id: SettingsNavId) => void;
  setSettingsQuery: (q: string) => void;
  rowControl: (rowId: string, value: string | number | boolean) => void;
  setProviderForm: (patch: Partial<ProviderFormState>) => void;
  addProvider: () => void;
  editProvider: (id: string) => void;
  deleteProvider: (id: string) => void;
  toggleProvider: (id: string) => void;
  makeDefault: (id: string) => void;
  refreshCatalog: () => void;

  reset: () => void;
}

export type DemoStore = DemoState & DemoActions;

// -- persistence ---------------------------------------------------------------

interface PersistedShell {
  lang: ReplicaLang;
  theme: 'light' | 'dark';
  fontScale: number;
  font: string;
  proxy: string;
  modelId: string;
  reasoning: ReasoningLevel;
  agentMode: AgentMode;
  permissionMode: PermissionChoice;
  renames: Record<string, string>;
  plugins: PluginRowData[];
  providers: ProviderCardData[];
  defaultModelLabel: string | null;
  notificationsRead: Record<string, boolean>;
}

function persist(state: DemoState): void {
  const read: Record<string, boolean> = {};
  for (const n of state.notifications) read[n.id] = n.read;
  const shell: PersistedShell = {
    lang: state.lang,
    theme: state.theme,
    fontScale: state.fontScale,
    font: state.font,
    proxy: state.proxy,
    modelId: state.modelId,
    reasoning: state.reasoning,
    agentMode: state.agentMode,
    permissionMode: state.permissionMode,
    renames: state.renames,
    plugins: state.plugins,
    providers: state.providers,
    defaultModelLabel: state.defaultModelLabel,
    notificationsRead: read,
  };
  savePreviewStore('shell', shell);
}

function hydrate(): Partial<DemoState> {
  const shell = loadPreviewStore<PersistedShell>('shell');
  if (!shell) return {};
  const notifications = demoNotifications(shell.lang).map((n) => ({
    ...n,
    read: shell.notificationsRead?.[n.id] ?? n.read,
  }));
  return {
    lang: shell.lang,
    theme: shell.theme,
    fontScale: shell.fontScale,
    font: shell.font,
    proxy: shell.proxy,
    modelId: shell.modelId,
    reasoning: shell.reasoning,
    agentMode: shell.agentMode,
    permissionMode: shell.permissionMode,
    renames: shell.renames ?? {},
    plugins: shell.plugins ?? demoInstalledPlugins(shell.lang),
    providers: shell.providers ?? demoProviders(),
    defaultModelLabel: shell.defaultModelLabel ?? null,
    notifications,
  };
}

// -- simulated runs --------------------------------------------------------------

let runTimers: number[] = [];

function clearRunTimers(): void {
  runTimers.forEach((t) => window.clearTimeout(t));
  runTimers = [];
}

function later(ms: number, fn: () => void): void {
  runTimers.push(window.setTimeout(fn, ms));
}

/** Appends a scripted, clearly-labeled simulated assistant reply. */
function simulateReply(sessionId: string, prompt: string, lang: ReplicaLang, set: (patch: Partial<DemoState>) => void, get: () => DemoState): void {
  const zh = lang === 'zh';
  set({ running: true });
  const id = `sim-${Date.now()}`;

  const push = (message: ChatMessage) => {
    const state = get();
    set({
      messages: {
        ...state.messages,
        [sessionId]: [...(state.messages[sessionId] ?? []), message],
      },
    });
  };

  later(500, () =>
    push({
      id,
      role: 'assistant',
      simulated: true,
      model: statelessModel(get()),
      parts: [
        {
          kind: 'text',
          id: `${id}-t1`,
          text: zh
            ? `收到：“${prompt.slice(0, 40)}”。这是**界面预览**中的模拟回复，用于演示对话样式，不涉及真实模型。`
            : `Got it: “${prompt.slice(0, 40)}”. This is a **simulated reply** in the UI preview — no real model is involved.`,
        },
      ],
    }),
  );
  later(1300, () =>
    push({
      id,
      role: 'assistant',
      simulated: true,
      model: statelessModel(get()),
      parts: [
        {
          kind: 'tool',
          id: `${id}-tool1`,
          tool: 'read_file',
          summary: 'src/replica/contracts.ts',
          status: 'running',
        },
      ],
    }),
  );
  later(2100, () => {
    const state = get();
    const msgs = state.messages[sessionId] ?? [];
    set({
      messages: {
        ...state.messages,
        [sessionId]: msgs.map((m) =>
          m.id === id
            ? {
                ...m,
                parts: m.parts.map((p) =>
                  p.kind === 'tool' && p.id === `${id}-tool1`
                    ? { ...p, status: 'done' as const, detailLines: ['export interface SidebarProps {', '// …40 lines'] }
                    : p,
                ),
              }
            : m,
        ),
      },
    });
  });
  later(3000, () =>
    push({
      id: `${id}-final`,
      role: 'assistant',
      simulated: true,
      model: statelessModel(get()),
      parts: [
        {
          kind: 'text',
          id: `${id}-t2`,
          text: zh
            ? '模拟结束。真实行为将在 pi 接入阶段由本地内核驱动。'
            : 'Simulation finished. Real behavior will be driven by the local pi runtime in phase two.',
        },
      ],
    }),
  );
  later(3100, () => set({ running: false }));
}

function statelessModel(state: DemoState): string {
  return state.modelId;
}

// -- store ------------------------------------------------------------------------

export const useDemoStore = create<DemoStore>((set, get) => {
  const initial = hydrate();
  const lang = initial.lang ?? 'zh';

  return {
    lang,
    theme: initial.theme ?? 'light',
    fontScale: initial.fontScale ?? 100,
    font: initial.font ?? 'System default',
    proxy: initial.proxy ?? 'System',
    view: 'home',
    settingsPage: 'general',
    sidebarCollapsed: false,
    expandedProjects: ['proj-apps'],

    activeSessionId: 'sess-plugin-ui',
    renames: initial.renames ?? {},
    newSessionCounter: 1,

    messages: demoMessagesBySession(lang),
    running: false,
    queued: 0,

    modelId: initial.modelId ?? 'gpt-5.6',
    reasoning: initial.reasoning ?? 'off',
    agentMode: initial.agentMode ?? 'agent',
    permissionMode: initial.permissionMode ?? 'ask',

    plugins: initial.plugins ?? demoInstalledPlugins(lang),
    marketplace: demoMarketplaceCards(lang),
    pluginTab: 'installed',
    pluginSearch: '',
    pluginTag: 'all',
    marketplaceSource: 'GitHub (official)',
    pluginUpdatesReady: 1,

    workbenchOpen: false,
    workbenchTab: 'review',
    selectedFile: null,

    searchOpen: false,
    searchQuery: '',
    notificationsOpen: false,
    notifications: initial.notifications ?? demoNotifications(lang),

    providers: initial.providers ?? demoProviders(),
    providerForm: { open: false, editingId: null, name: '', baseUrl: '', apiKey: '', modelLine: '' },
    defaultModelLabel: initial.defaultModelLabel ?? null,

    resetCounter: 0,

    // -- actions ------------------------------------------------------------------

    navigate: (view) => set({ view, notificationsOpen: false }),
    openSettings: (page) => set({ view: 'settings', settingsPage: page ?? get().settingsPage, notificationsOpen: false }),
    backToApp: () => set({ view: get().activeSessionId ? 'chat' : 'home' }),
    toggleSidebar: () => set({ sidebarCollapsed: !get().sidebarCollapsed }),
    toggleProject: (id) =>
      set({ expandedProjects: get().expandedProjects.includes(id) ? get().expandedProjects.filter((p) => p !== id) : [...get().expandedProjects, id] }),

    selectSession: (id) => set({ activeSessionId: id, view: 'chat' }),
    newSession: () => {
      const n = get().newSessionCounter + 1;
      const id = `sess-new-${n}`;
      set({
        newSessionCounter: n,
        activeSessionId: id,
        view: 'chat',
        messages: { ...get().messages, [id]: [] },
      });
    },
    renameSession: (id) => {
      const langNow = get().lang;
      const title = window.prompt(langNow === 'zh' ? '重命名会话（演示）' : 'Rename session (demo)', get().renames[id] ?? '');
      if (title && title.trim()) {
        set({ renames: { ...get().renames, [id]: title.trim() } });
        persist(get());
      }
    },

    send: (text) => {
      const state = get();
      let sessionId = state.activeSessionId;
      if (!sessionId) {
        const n = state.newSessionCounter + 1;
        sessionId = `sess-new-${n}`;
        set({ newSessionCounter: n, activeSessionId: sessionId, view: 'chat' });
      }
      const userMsg: ChatMessage = {
        id: `u-${Date.now()}`,
        role: 'user',
        parts: [{ kind: 'text', id: `u-${Date.now()}-t`, text }],
      };
      set({
        messages: { ...state.messages, [sessionId]: [...(state.messages[sessionId] ?? []), userMsg] },
        view: 'chat',
      });
      simulateReply(sessionId, text, state.lang, set, get);
    },
    stop: () => {
      clearRunTimers();
      set({ running: false });
    },

    setLang: (lang2) => {
      set({
        lang: lang2,
        // Refresh static demo content so language switching is visible.
        plugins: demoInstalledPlugins(lang2),
        marketplace: demoMarketplaceCards(lang2),
        notifications: demoNotifications(lang2).map((n) => ({ ...n, read: get().notifications.find((o) => o.id === n.id)?.read ?? n.read })),
        messages: demoMessagesBySession(lang2),
      });
      persist(get());
    },
    setTheme: (theme) => {
      set({ theme });
      persist(get());
    },
    setFontScale: (pct) => {
      set({ fontScale: pct });
      persist(get());
    },
    setFont: (font) => {
      set({ font });
      persist(get());
    },
    setProxy: (mode) => {
      set({ proxy: mode });
      persist(get());
    },
    setComposer: (patch) => {
      set(patch);
      persist(get());
    },

    setPluginTab: (tab) => set({ pluginTab: tab }),
    setPluginSearch: (q) => set({ pluginSearch: q }),
    setPluginTag: (tag) => set({ pluginTag: tag }),
    setMarketplaceSource: (s) => set({ marketplaceSource: s }),
    togglePlugin: (id) => {
      const plugins = get().plugins.map((p) =>
        p.id === id
          ? p.status === 'off'
            ? { ...p, status: 'active' as const, error: undefined }
            : { ...p, status: 'off' as const }
          : p,
      );
      set({ plugins });
      persist(get());
    },
    updatePlugin: (id) => {
      const plugins = get().plugins.map((p) =>
        p.id === id && p.latestVersion ? { ...p, version: p.latestVersion, status: 'active' as const } : p,
      );
      set({ plugins, pluginUpdatesReady: Math.max(0, get().pluginUpdatesReady - 1) });
      persist(get());
    },
    installPlugin: (id) => {
      const state = get();
      const card = state.marketplace.find((m) => m.id === id);
      if (!card) return;
      const plugins: PluginRowData[] = [
        ...state.plugins,
        {
          id: `pl-${card.id}`,
          name: card.name,
          packageId: `pi.${card.id.replace(/^mp-/, '')}`,
          version: card.version,
          status: 'active',
          scope: 'everywhere',
          details: ['Demo install — nothing was loaded on this machine.'],
          latestVersion: card.version,
        },
      ];
      const marketplace = state.marketplace.map((m) =>
        m.id === id ? { ...m, installedVersion: m.version, updateAvailable: false } : m,
      );
      set({ plugins, marketplace });
      persist(get());
    },
    applyUpdates: () => {
      const plugins = get().plugins.map((p) =>
        p.status === 'updatable' && p.latestVersion ? { ...p, version: p.latestVersion, status: 'active' as const } : p,
      );
      set({ plugins, pluginUpdatesReady: 0 });
      persist(get());
    },
    refreshMarketplace: () => set({}),

    toggleWorkbench: () => set({ workbenchOpen: !get().workbenchOpen }),
    selectWorkbenchTab: (tab) => set({ workbenchTab: tab, workbenchOpen: true }),
    selectFile: (path) => set({ selectedFile: path }),

    setSearchOpen: (open) => set({ searchOpen: open, searchQuery: open ? get().searchQuery : '' }),
    setSearchQuery: (q) => set({ searchQuery: q }),
    toggleNotifications: () => set({ notificationsOpen: !get().notificationsOpen }),
    markAllRead: () => {
      set({ notifications: get().notifications.map((n) => ({ ...n, read: true })) });
      persist(get());
    },

    selectSettingsPage: (id) => set({ settingsPage: id }),
    setSettingsQuery: (q) => set({ searchQuery: q }),
    rowControl: (rowId, value) => {
      const state = get();
      if (rowId === 'theme') set({ theme: value === 'Dark' ? 'dark' : value === 'Light' ? 'light' : state.theme });
      else if (rowId === 'language') set({ lang: value === '中文' ? 'zh' : 'en' });
      else if (rowId === 'fontsize') set({ fontScale: typeof value === 'number' ? value : 100 });
      else if (rowId === 'font') set({ font: String(value) });
      else if (rowId === 'proxy') set({ proxy: String(value) });
      persist(get());
    },
    setProviderForm: (patch) => set({ providerForm: { ...get().providerForm, ...patch } }),
    addProvider: () => {
      const form = get().providerForm;
      const name = form.name.trim();
      const models = form.models ?? form.modelLine
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      if (!name || models.length === 0) {
        set({
          providerForm: {
            ...form,
            error: !name ? 'name' : 'model',
          },
        });
        return;
      }
      const providers: ProviderCardData[] = [
        ...get().providers.filter(p=>p.id!==form.editingId),
        { id: form.editingId ?? `prov-${Date.now()}`, name, baseUrl: form.baseUrl.trim() || '—', modelCount: models.length, isDefault: false, enabled: true, source: 'models.json', models: models.map((m) => typeof m === 'string' ? ({id:m}) : m) },
      ];
      set({ providers, providerForm: { open: false, editingId: null, name: '', baseUrl: '', apiKey: '', modelLine: '' } });
      persist(get());
    },
    editProvider: (id) => {
      const p = get().providers.find((pp) => pp.id === id);
      if (p) set({ providerForm: { open: true, editingId: id, name: p.name, baseUrl: p.baseUrl, apiKey: '', modelLine: '', models: p.models.map(m=>({...m})) } });
    },
    deleteProvider: (id) => {
      set({ providers: get().providers.filter((p) => p.id !== id) });
      persist(get());
    },
    toggleProvider: (id) => {
      set({ providers: get().providers.map((p) => (p.id === id ? { ...p, enabled: !p.enabled } : p)) });
      persist(get());
    },
    makeDefault: (id) => {
      set({ defaultModelLabel: get().providers.find((p) => p.id === id)?.name ?? null });
      persist(get());
    },
    refreshCatalog: () => set({}),

    reset: () => {
      clearRunTimers();
      resetPreviewStore();
      const lang2 = get().lang;
      set({
        theme: 'light',
        fontScale: 100,
        font: 'System default',
        proxy: 'System',
        view: 'home',
        settingsPage: 'general',
        sidebarCollapsed: false,
        expandedProjects: ['proj-apps'],
        activeSessionId: 'sess-plugin-ui',
        renames: {},
        newSessionCounter: 1,
        messages: demoMessagesBySession(lang2),
        running: false,
        queued: 0,
        modelId: 'gpt-5.6',
        reasoning: 'off',
        agentMode: 'agent',
        permissionMode: 'ask',
        plugins: demoInstalledPlugins(lang2),
        marketplace: demoMarketplaceCards(lang2),
        pluginTab: 'installed',
        pluginSearch: '',
        pluginTag: 'all',
        pluginUpdatesReady: 1,
        workbenchOpen: false,
        workbenchTab: 'review',
        selectedFile: null,
        searchOpen: false,
        searchQuery: '',
        notificationsOpen: false,
        notifications: demoNotifications(lang2),
        providers: demoProviders(),
        providerForm: { open: false, editingId: null, name: '', baseUrl: '', apiKey: '', modelLine: '' },
        defaultModelLabel: null,
        resetCounter: get().resetCounter + 1,
      });
    },
  };
});

// -- derived selectors used by PreviewApp (pure, exported for tests) ----------------

export function buildSidebarModel(state: DemoState): {
  temporary: SessionNavItem[];
  projects: ProjectNavItem[];
} {
  const title = (s: { id: string; title: string }) => state.renames[s.id] ?? s.title;
  const temporary = demoTemporarySessions(state.lang).map((s) => ({ ...s, title: title(s) }));
  const projects = demoProjects(state.lang).map((p) => {
    const sessions = (demoProjectSessions(state.lang)[p.id] ?? []).map((s) => ({ ...s, title: title(s) }));
    return { id: p.id, name: p.name, path: p.path, expanded: state.expandedProjects.includes(p.id), emptyHint: sessions.length === 0, sessions };
  });
  return { temporary, projects };
}

export function sessionTitle(state: DemoState, id: string | null): string {
  if (!id) return '';
  if (state.renames[id]) return state.renames[id];
  const all = [...demoTemporarySessions(state.lang), ...Object.values(demoProjectSessions(state.lang)).flat()];
  return all.find((s) => s.id === id)?.title ?? (id.startsWith('sess-new-') ? (state.lang === 'zh' ? '新会话' : 'New session') : id);
}

export function activeSessionMeta(state: DemoState): { source: 'desktop' | 'pi-cli'; syncedAt?: string; canContinue?: boolean } {
  const id = state.activeSessionId;
  const all = [...demoTemporarySessions(state.lang), ...Object.values(demoProjectSessions(state.lang)).flat()];
  const found = all.find((s) => s.id === id);
  return { source: found?.source ?? 'desktop', syncedAt: found?.syncedAt, canContinue: found?.canContinue };
}
