import type {
  AgentStatus,
  AppEvent,
  AppSettings,
  DirEntry,
  FileDiff,
  ProjectInfo,
  ProviderView,
  SessionData,
  SessionMeta,
  SessionMode,
} from './types';

/**
 * The typed bridge surface exposed on `window.pi` by the preload script.
 * Declared here (pure types) so the renderer never imports Electron modules.
 */

export type UserChoice = 'allow_once' | 'allow_session' | 'deny';

export interface ProviderSaveInput {
  id?: string;
  type: ProviderView['type'];
  name: string;
  baseUrl?: string;
  apiKeyPlain?: string;
  clearApiKey?: boolean;
  models: Array<{
    name: string;
    model: string;
    contextWindow?: number;
    maxOutputTokens?: number;
    supportsReasoning?: boolean;
  }>;
}

export interface ChangeSummary {
  path: string;
  created: boolean;
  diff: FileDiff;
}

export interface PiApi {
  appInfo(): Promise<{ version: string; platform: string; userData: string }>;
  pickDirectory(): Promise<string | null>;
  listDir(dir: string): Promise<DirEntry[]>;

  listProjects(): Promise<ProjectInfo[]>;
  addProject(path: string): Promise<ProjectInfo>;
  removeProject(id: string): Promise<void>;

  listSessions(projectId: string): Promise<SessionMeta[]>;
  createSession(
    projectId: string,
    opts?: { title?: string; modelId?: string; mode?: SessionMode },
  ): Promise<SessionMeta>;
  loadSession(projectId: string, sessionId: string): Promise<SessionData>;
  updateSession(
    projectId: string,
    sessionId: string,
    patch: Partial<Pick<SessionMeta, 'title' | 'pinned' | 'archived' | 'modelId' | 'mode'>>,
  ): Promise<SessionMeta>;
  approvePlan(projectId: string, sessionId: string): Promise<SessionMeta>;
  deleteSession(projectId: string, sessionId: string): Promise<void>;
  sessionChanges(projectId: string, sessionId: string): Promise<ChangeSummary[]>;

  sendPrompt(sessionId: string, text: string): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  status(sessionId: string): Promise<AgentStatus>;

  getSettings(): Promise<AppSettings>;
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  listProviders(): Promise<ProviderView[]>;
  saveProvider(input: ProviderSaveInput): Promise<ProviderView[]>;
  deleteProvider(id: string): Promise<ProviderView[]>;

  respondPermission(requestId: string, choice: UserChoice): Promise<void>;
  onEvent(cb: (event: AppEvent) => void): () => void;
}
