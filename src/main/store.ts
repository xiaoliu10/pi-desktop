import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  AppSettings,
  FileDiff,
  ProjectInfo,
  ProviderConfig,
  ProviderView,
  SessionData,
  SessionMeta,
  TranscriptEvent,
} from '../shared/types';
import { DEFAULT_SETTINGS } from '../shared/types';
import { decryptSecret, encryptSecret } from './secrets';

/**
 * Local-first persistence. Everything lives under the Electron userData dir:
 *
 *   settings.json                    app settings
 *   models.json                      providers + models (API keys encrypted)
 *   projects.json                    registered project folders
 *   sessions/<projectId>/<sessionId>/
 *     meta.json                      session metadata
 *     events.jsonl                   append-only transcript
 */

export class Store {
  /** Root is resolved lazily because app.getPath('userData') needs the app. */
  constructor(private readonly rootFn: () => string) {}

  private get root(): string {
    return this.rootFn();
  }

  // -- generic json helpers -------------------------------------------------

  private file(name: string): string {
    return path.join(this.root, name);
  }

  private readJson<T>(file: string, fallback: T): T {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
    } catch {
      return fallback;
    }
  }

  private writeJson(file: string, value: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
  }

  private sessionDir(projectId: string, sessionId: string): string {
    return path.join(this.root, 'sessions', projectId, sessionId);
  }

  // -- settings --------------------------------------------------------------

  getSettings(): AppSettings {
    return { ...DEFAULT_SETTINGS, ...this.readJson(this.file('settings.json'), {}) };
  }

  setSettings(patch: Partial<AppSettings>): AppSettings {
    const next = { ...this.getSettings(), ...patch };
    this.writeJson(this.file('settings.json'), next);
    return next;
  }

  // -- providers & models -----------------------------------------------------

  private readModels(): { providers: ProviderConfig[] } {
    return this.readJson(this.file('models.json'), { providers: [] });
  }

  listProviders(): ProviderView[] {
    return this.readModels().providers.map((p) => ({
      id: p.id,
      type: p.type,
      name: p.name,
      baseUrl: p.baseUrl,
      hasApiKey: Boolean(p.apiKeyEnc),
      models: p.models,
    }));
  }

  saveProvider(input: {
    id?: string;
    type: ProviderConfig['type'];
    name: string;
    baseUrl?: string;
    apiKeyPlain?: string;
    clearApiKey?: boolean;
    models: Array<Omit<ProviderConfig['models'][number], 'id' | 'providerId'>>;
  }): ProviderView[] {
    const data = this.readModels();
    const id = input.id ?? randomUUID();
    const existing = data.providers.find((p) => p.id === id);
    let apiKeyEnc = existing?.apiKeyEnc;
    if (input.clearApiKey) apiKeyEnc = undefined;
    if (input.apiKeyPlain !== undefined && input.apiKeyPlain !== '') {
      apiKeyEnc = encryptSecret(input.apiKeyPlain);
    }
    const provider: ProviderConfig = {
      id,
      type: input.type,
      name: input.name,
      baseUrl: input.baseUrl || undefined,
      apiKeyEnc,
      models: input.models.map((m) => ({
        ...m,
        id: `${id}/${m.model}`,
        providerId: id,
      })),
    };
    const idx = data.providers.findIndex((p) => p.id === id);
    if (idx >= 0) data.providers[idx] = provider;
    else data.providers.push(provider);
    this.writeJson(this.file('models.json'), data);
    return this.listProviders();
  }

  deleteProvider(id: string): ProviderView[] {
    const data = this.readModels();
    data.providers = data.providers.filter((p) => p.id !== id);
    this.writeJson(this.file('models.json'), data);
    return this.listProviders();
  }

  /** Resolve a model id ("providerId/modelKey") to config + decrypted key. */
  resolveModel(modelId: string): { provider: ProviderConfig; model: ProviderConfig['models'][number]; apiKey: string | null } {
    const data = this.readModels();
    for (const p of data.providers) {
      const m = p.models.find((mm) => mm.id === modelId);
      if (m) {
        return { provider: p, model: m, apiKey: decryptSecret(p.apiKeyEnc) };
      }
    }
    throw new Error(`Unknown model: ${modelId}`);
  }

  // -- projects ---------------------------------------------------------------

  listProjects(): ProjectInfo[] {
    return this.readJson<ProjectInfo[]>(this.file('projects.json'), []);
  }

  addProject(projectPath: string): ProjectInfo {
    const resolved = path.resolve(projectPath);
    const st = fs.statSync(resolved);
    if (!st.isDirectory()) throw new Error(`Not a directory: ${resolved}`);
    const projects = this.listProjects();
    const existing = projects.find((p) => p.path === resolved);
    if (existing) return existing;
    const info: ProjectInfo = {
      id: randomUUID(),
      name: path.basename(resolved),
      path: resolved,
      createdAt: Date.now(),
    };
    projects.push(info);
    this.writeJson(this.file('projects.json'), projects);
    return info;
  }

  removeProject(id: string): void {
    const projects = this.listProjects().filter((p) => p.id !== id);
    this.writeJson(this.file('projects.json'), projects);
    fs.rmSync(path.join(this.root, 'sessions', id), { recursive: true, force: true });
  }

  getProject(id: string): ProjectInfo {
    const p = this.listProjects().find((pp) => pp.id === id);
    if (!p) throw new Error(`Unknown project: ${id}`);
    return p;
  }

  // -- sessions -----------------------------------------------------------------

  listSessions(projectId: string): SessionMeta[] {
    const dir = path.join(this.root, 'sessions', projectId);
    let ids: string[] = [];
    try {
      ids = fs.readdirSync(dir);
    } catch {
      return [];
    }
    const metas: SessionMeta[] = [];
    for (const id of ids) {
      const meta = this.readJson<SessionMeta | null>(path.join(dir, id, 'meta.json'), null);
      if (meta) metas.push(meta);
    }
    metas.sort((a, b) => {
      if (Boolean(b.pinned) !== Boolean(a.pinned)) return Number(b.pinned) - Number(a.pinned);
      return b.updatedAt - a.updatedAt;
    });
    return metas;
  }

  createSession(projectId: string, opts?: { title?: string; modelId?: string; mode?: SessionMeta['mode'] }): SessionMeta {
    const meta: SessionMeta = {
      id: randomUUID(),
      projectId,
      title: opts?.title ?? 'New session',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      modelId: opts?.modelId,
      mode: opts?.mode ?? 'agent',
    };
    this.writeJson(path.join(this.sessionDir(projectId, meta.id), 'meta.json'), meta);
    return meta;
  }

  getSessionMeta(projectId: string, sessionId: string): SessionMeta {
    const meta = this.readJson<SessionMeta | null>(path.join(this.sessionDir(projectId, sessionId), 'meta.json'), null);
    if (!meta) throw new Error(`Unknown session: ${sessionId}`);
    return meta;
  }

  updateSessionMeta(projectId: string, sessionId: string, patch: Partial<SessionMeta>): SessionMeta {
    const meta = { ...this.getSessionMeta(projectId, sessionId), ...patch, updatedAt: Date.now() };
    this.writeJson(path.join(this.sessionDir(projectId, sessionId), 'meta.json'), meta);
    return meta;
  }

  deleteSession(projectId: string, sessionId: string): void {
    fs.rmSync(this.sessionDir(projectId, sessionId), { recursive: true, force: true });
  }

  readEvents(projectId: string, sessionId: string): TranscriptEvent[] {
    const file = path.join(this.sessionDir(projectId, sessionId), 'events.jsonl');
    try {
      const text = fs.readFileSync(file, 'utf8');
      return text
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as TranscriptEvent);
    } catch {
      return [];
    }
  }

  loadSession(projectId: string, sessionId: string): SessionData {
    return {
      meta: this.getSessionMeta(projectId, sessionId),
      events: this.readEvents(projectId, sessionId),
    };
  }

  appendEvent(projectId: string, sessionId: string, event: TranscriptEvent): void {
    const file = path.join(this.sessionDir(projectId, sessionId), 'events.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(event) + '\n', 'utf8');
    // Touch meta updatedAt so session lists stay fresh.
    const metaFile = path.join(this.sessionDir(projectId, sessionId), 'meta.json');
    const meta = this.readJson<SessionMeta | null>(metaFile, null);
    if (meta) {
      meta.updatedAt = Date.now();
      this.writeJson(metaFile, meta);
    }
  }

  /**
   * Collect every file change recorded in a session's transcript, keeping the
   * latest diff per path.
   */
  sessionChanges(projectId: string, sessionId: string): Array<{ path: string; created: boolean; diff: FileDiff }> {
    const byPath = new Map<string, { path: string; created: boolean; diff: FileDiff }>();
    for (const ev of this.readEvents(projectId, sessionId)) {
      if (ev.t === 'tool_result' && ev.ok && ev.diff) {
        byPath.set(ev.diff.path, { path: ev.diff.path, created: Boolean(ev.diff.created), diff: ev.diff });
      }
    }
    return [...byPath.values()];
  }
}
