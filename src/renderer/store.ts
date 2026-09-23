import { create } from 'zustand';
import type {
  AgentStatus,
  AppEvent,
  AppSettings,
  FileDiff,
  PermissionRequest,
  ProjectInfo,
  ProviderView,
  SessionMeta,
  TranscriptEvent,
} from '@shared/types';
import type { PiApi } from '@shared/api';

declare global {
  interface Window {
    pi: PiApi;
  }
}

export interface SessionChangeView {
  path: string;
  created: boolean;
  diff: FileDiff;
  additions: number;
  deletions: number;
}

interface RendererState {
  // app
  ready: boolean;
  appVersion: string;
  platform: string;
  userData: string;
  settings: AppSettings;

  // data
  projects: ProjectInfo[];
  activeProjectId: string | null;
  sessions: SessionMeta[];
  sessionMeta: SessionMeta | null;
  events: TranscriptEvent[];
  streaming: Record<string, string>;
  statuses: Record<string, AgentStatus>;
  providers: ProviderView[];
  queued: Record<string, number>;

  // ui state
  permissionRequest: PermissionRequest | null;
  settingsOpen: boolean;
  reviewOpen: boolean;
  changes: SessionChangeView[];

  // actions
  init: () => Promise<void>;
  setLanguage: (lang: AppSettings['language']) => Promise<void>;
  setSettings: (patch: Partial<AppSettings>) => Promise<void>;
  reloadProviders: () => Promise<void>;
  addProject: (path: string) => Promise<void>;
  removeProject: (id: string) => Promise<void>;
  selectProject: (id: string | null) => Promise<void>;
  newSession: (opts?: { modelId?: string; mode?: SessionMeta['mode'] }) => Promise<void>;
  selectSession: (id: string) => Promise<void>;
  updateSession: (patch: Partial<Pick<SessionMeta, 'title' | 'pinned' | 'archived' | 'modelId' | 'mode'>>) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  approvePlan: () => Promise<void>;
  sendPrompt: (text: string) => Promise<void>;
  interrupt: () => Promise<void>;
  refreshChanges: () => Promise<void>;
  toggleReview: () => void;
  setSettingsOpen: (open: boolean) => void;
  respondPermission: (choice: 'allow_once' | 'allow_session' | 'deny') => Promise<void>;
  handleAppEvent: (event: AppEvent) => void;
}

function countDiffLines(diff: FileDiff): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const h of diff.hunks) {
    for (const l of h.lines) {
      if (l.type === '+') additions++;
      else if (l.type === '-') deletions++;
    }
  }
  return { additions, deletions };
}

export const useStore = create<RendererState>((set, get) => ({
  ready: false,
  appVersion: '',
  platform: '',
  userData: '',
  settings: { language: 'zh', permissionMode: 'ask', theme: 'dark' },

  projects: [],
  activeProjectId: null,
  sessions: [],
  sessionMeta: null,
  events: [],
  streaming: {},
  statuses: {},
  providers: [],
  queued: {},

  permissionRequest: null,
  settingsOpen: false,
  reviewOpen: false,
  changes: [],

  init: async () => {
    const info = await window.pi.appInfo();
    const settings = await window.pi.getSettings();
    const projects = await window.pi.listProjects();
    const providers = await window.pi.listProviders();
    set({ ready: true, appVersion: info.version, platform: info.platform, userData: info.userData, settings, projects, providers });
    window.pi.onEvent((event) => get().handleAppEvent(event));
    if (projects.length > 0) {
      await get().selectProject(projects[0].id);
    }
  },

  setLanguage: async (language) => {
    const settings = await window.pi.setSettings({ language });
    set({ settings });
  },

  setSettings: async (patch) => {
    const settings = await window.pi.setSettings(patch);
    set({ settings });
  },

  reloadProviders: async () => {
    set({ providers: await window.pi.listProviders() });
  },

  addProject: async (path) => {
    const info = await window.pi.addProject(path);
    await get().selectProject(info.id);
  },

  removeProject: async (id) => {
    await window.pi.removeProject(id);
    const projects = get().projects.filter((p) => p.id !== id);
    set({ projects });
    if (get().activeProjectId === id) {
      await get().selectProject(projects[0]?.id ?? null);
    }
  },

  selectProject: async (id) => {
    set({ activeProjectId: id, sessions: [], sessionMeta: null, events: [], streaming: {}, changes: [], reviewOpen: false });
    if (!id) return;
    const sessions = await window.pi.listSessions(id);
    const visible = sessions.filter((s) => !s.archived);
    set({ sessions });
    if (visible.length > 0) {
      await get().selectSession(visible[0].id);
    }
  },

  newSession: async (opts) => {
    const projectId = get().activeProjectId;
    if (!projectId) return;
    const meta = await window.pi.createSession(projectId, opts);
    const sessions = await window.pi.listSessions(projectId);
    set({ sessions, sessionMeta: meta, events: [], streaming: {}, changes: [], reviewOpen: false });
  },

  selectSession: async (id) => {
    const projectId = get().activeProjectId;
    if (!projectId) return;
    const data = await window.pi.loadSession(projectId, id);
    set({
      sessionMeta: data.meta,
      events: data.events,
      streaming: {},
      queued: { ...get().queued, [id]: 0 },
    });
    const status = await window.pi.status(id);
    set({ statuses: { ...get().statuses, [id]: status } });
    void get().refreshChanges();
  },

  updateSession: async (patch) => {
    const { activeProjectId, sessionMeta } = get();
    if (!activeProjectId || !sessionMeta) return;
    const meta = await window.pi.updateSession(activeProjectId, sessionMeta.id, patch);
    set({ sessionMeta: meta });
    const sessions = await window.pi.listSessions(activeProjectId);
    set({ sessions });
  },

  deleteSession: async (id) => {
    const projectId = get().activeProjectId;
    if (!projectId) return;
    await window.pi.deleteSession(projectId, id);
    const sessions = (await window.pi.listSessions(projectId)).filter((s) => !s.archived);
    set({ sessions });
    if (get().sessionMeta?.id === id) {
      if (sessions.length > 0) await get().selectSession(sessions[0].id);
      else set({ sessionMeta: null, events: [], changes: [] });
    }
  },

  approvePlan: async () => {
    const { activeProjectId, sessionMeta } = get();
    if (!activeProjectId || !sessionMeta) return;
    const meta = await window.pi.approvePlan(activeProjectId, sessionMeta.id);
    set({
      sessionMeta: meta,
      events: [
        ...get().events,
        { t: 'plan', id: `local-${Date.now()}`, ts: Date.now(), text: '', status: 'approved' as const },
      ],
    });
  },

  sendPrompt: async (text) => {
    const sessionId = get().sessionMeta?.id;
    if (!sessionId) return;
    // Fire-and-forget: progress arrives as agent events; the promise settles
    // when the whole run (including queued prompts) finishes.
    void window.pi.sendPrompt(sessionId, text).catch((err) => {
      set({
        events: [
          ...get().events,
          { t: 'error', id: `local-${Date.now()}`, ts: Date.now(), message: String(err?.message ?? err) },
        ],
      });
    });
  },

  interrupt: async () => {
    const sessionId = get().sessionMeta?.id;
    if (!sessionId) return;
    await window.pi.interrupt(sessionId);
  },

  refreshChanges: async () => {
    const { activeProjectId, sessionMeta } = get();
    if (!activeProjectId || !sessionMeta) {
      set({ changes: [] });
      return;
    }
    const raw = await window.pi.sessionChanges(activeProjectId, sessionMeta.id);
    const changes = raw.map((c) => ({ ...c, ...countDiffLines(c.diff) }));
    set({ changes });
  },

  toggleReview: () => {
    const next = !get().reviewOpen;
    set({ reviewOpen: next });
    if (next) void get().refreshChanges();
  },

  setSettingsOpen: (open) => set({ settingsOpen: open }),

  respondPermission: async (choice) => {
    const request = get().permissionRequest;
    if (!request) return;
    set({ permissionRequest: null });
    await window.pi.respondPermission(request.requestId, choice);
  },

  handleAppEvent: (event) => {
    const state = get();
    const sessionId = state.sessionMeta?.id;
    switch (event.type) {
      case 'permission':
        if (event.request.sessionId === sessionId) {
          set({ permissionRequest: event.request, statuses: { ...state.statuses, [sessionId]: 'awaiting_permission' } });
        }
        break;
      case 'agent':
        switch (event.event.kind) {
          case 'transcript': {
            const { sessionId: sid, event: te } = event.event;
            if (sid !== sessionId) break;
            const events = state.events;
            if (events.some((e) => e.id === te.id)) break;
            const streaming = { ...state.streaming };
            if (te.t === 'assistant' && streaming[te.id] !== undefined) delete streaming[te.id];
            set({ events: [...events, te], streaming });
            void state.refreshChanges();
            break;
          }
          case 'message-start': {
            const { sessionId: sid, messageId } = event.event;
            if (sid !== sessionId) break;
            set({ streaming: { ...state.streaming, [messageId]: '' } });
            break;
          }
          case 'text-delta': {
            const { sessionId: sid, messageId, delta } = event.event;
            if (sid !== sessionId) break;
            const cur = state.streaming[messageId];
            if (cur === undefined) break;
            set({ streaming: { ...state.streaming, [messageId]: cur + delta } });
            break;
          }
          case 'status': {
            const { sessionId: sid, status, queue } = event.event;
            set({
              statuses: { ...get().statuses, [sid]: status },
              queued: { ...get().queued, [sid]: queue ?? 0 },
              // A finished run means no prompt is waiting on permission anymore.
              permissionRequest: status === 'idle' && state.permissionRequest?.sessionId === sid ? null : state.permissionRequest,
            });
            break;
          }
          case 'error': {
            const { sessionId: sid, message } = event.event;
            if (sid !== sessionId) break;
            set({
              events: [...state.events, { t: 'error', id: `err-${Date.now()}`, ts: Date.now(), message }],
            });
            break;
          }
          case 'usage':
            break;
        }
        break;
      case 'projects-changed':
        void window.pi.listProjects().then((projects) => set({ projects }));
        break;
      case 'sessions-changed':
        if (event.projectId === state.activeProjectId) {
          void window.pi.listSessions(event.projectId).then((sessions) => set({ sessions }));
        }
        break;
    }
  },
}));
