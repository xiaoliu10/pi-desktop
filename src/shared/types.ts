/**
 * Shared domain types and IPC protocol between the Electron main process
 * (host core + agent runtime) and the React renderer.
 *
 * The renderer has no Node integration — everything crosses the typed
 * preload bridge defined in src/preload.
 */

// ---------------------------------------------------------------------------
// Models & providers
// ---------------------------------------------------------------------------

export type ProviderType = 'openai-compatible' | 'anthropic';

export interface ModelConfig {
  /** Stable id within the app (providerId + '/' + model key). */
  id: string;
  /** Display name. */
  name: string;
  /** Owning provider id. */
  providerId: string;
  /** Provider-side model key, e.g. "gpt-4o" or "claude-sonnet-4-5". */
  model: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsReasoning?: boolean;
}

export interface ProviderConfig {
  id: string;
  type: ProviderType;
  name: string;
  /** API base URL. Defaults per type when omitted. */
  baseUrl?: string;
  /** Encrypted API key (safeStorage). Never leaves the main process. */
  apiKeyEnc?: string;
  models: ModelConfig[];
}

/** Provider as exposed to the renderer (secret redacted). */
export interface ProviderView {
  id: string;
  type: ProviderType;
  name: string;
  baseUrl?: string;
  hasApiKey: boolean;
  models: ModelConfig[];
}

// ---------------------------------------------------------------------------
// Projects & sessions
// ---------------------------------------------------------------------------

export interface ProjectInfo {
  id: string;
  name: string;
  path: string;
  createdAt: number;
}

export type SessionMode = 'agent' | 'plan' | 'goal';

export interface SessionMeta {
  id: string;
  projectId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  pinned?: boolean;
  archived?: boolean;
  modelId?: string;
  mode: SessionMode;
  /** Plan mode: set once the user approves the proposed plan. */
  planApproved?: boolean;
}

export interface SessionData {
  meta: SessionMeta;
  events: TranscriptEvent[];
}

// ---------------------------------------------------------------------------
// Transcript (persisted as JSONL, one event per line)
// ---------------------------------------------------------------------------

export interface FileDiff {
  path: string;
  created?: boolean;
  hunks: DiffHunk[];
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface DiffLine {
  type: ' ' | '+' | '-';
  text: string;
}

export type TranscriptEvent =
  | { t: 'user'; id: string; ts: number; text: string }
  | { t: 'assistant'; id: string; ts: number; text: string; model?: string }
  | { t: 'tool_call'; id: string; ts: number; name: string; args: Record<string, unknown>; summary?: string }
  | {
      t: 'tool_result';
      id: string;
      callId: string;
      ts: number;
      ok: boolean;
      output?: string;
      diff?: FileDiff;
      error?: string;
      truncated?: boolean;
    }
  | { t: 'error'; id: string; ts: number; message: string }
  | { t: 'notice'; id: string; ts: number; text: string }
  | { t: 'plan'; id: string; ts: number; text: string; status: 'proposed' | 'approved' };

// ---------------------------------------------------------------------------
// Agent runtime events (ephemeral, streamed over IPC)
// ---------------------------------------------------------------------------

export type AgentStatus = 'idle' | 'running' | 'awaiting_permission' | 'awaiting_plan';

export type AgentEvent =
  | { kind: 'status'; sessionId: string; status: AgentStatus; queue?: number }
  | { kind: 'message-start'; sessionId: string; messageId: string }
  | { kind: 'text-delta'; sessionId: string; messageId: string; delta: string }
  | { kind: 'transcript'; sessionId: string; event: TranscriptEvent }
  | { kind: 'usage'; sessionId: string; inputTokens: number; outputTokens: number }
  | { kind: 'error'; sessionId: string; message: string };

export interface PermissionRequest {
  requestId: string;
  sessionId: string;
  tool: string;
  summary: string;
  detail?: string;
}

export type AppEvent =
  | { type: 'agent'; event: AgentEvent }
  | { type: 'permission'; request: PermissionRequest }
  | { type: 'projects-changed' }
  | { type: 'sessions-changed'; projectId: string };

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export type PermissionMode = 'ask' | 'autoEdit' | 'fullAccess';

export interface DirEntry {
  name: string;
  kind: 'file' | 'dir';
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface AppSettings {
  language: 'en' | 'zh';
  permissionMode: PermissionMode;
  theme: 'dark';
}

export const DEFAULT_SETTINGS: AppSettings = {
  language: 'zh',
  permissionMode: 'ask',
  theme: 'dark',
};

// ---------------------------------------------------------------------------
// Session changes (review panel)
// ---------------------------------------------------------------------------

export interface SessionChange {
  path: string;
  created: boolean;
  additions: number;
  deletions: number;
  diff: FileDiff;
}
