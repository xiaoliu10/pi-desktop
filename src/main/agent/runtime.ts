import { randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import type {
  AgentEvent,
  AgentStatus,
  AppEvent,
  AppSettings,
  SessionMeta,
  TranscriptEvent,
} from '../../shared/types';
import type { Store } from '../store';
import type { ToolCallRequest } from '../providers/base';
import { createProvider } from '../providers';
import { toolByName, toolSchemas, type ToolContext } from './tools';
import { buildChatMessages, systemPrompt } from './prompt';
import { PermissionService } from './permissions';

const MAX_STEPS = 30;

/**
 * The agent loop. One process-wide instance; each session has at most one
 * active run. Prompts that arrive while a run is active are queued and
 * executed in order.
 */
export class AgentRuntime {
  private runs = new Map<string, RunState>();

  constructor(
    private readonly deps: {
      store: Store;
      getWindow: () => BrowserWindow | null;
      permissions: PermissionService;
      getSettings: () => AppSettings;
    },
  ) {}

  // -- public API -----------------------------------------------------------

  async sendPrompt(sessionId: string, text: string): Promise<void> {
    const meta = this.metaFor(sessionId);
    const userEvent: TranscriptEvent = { t: 'user', id: randomUUID(), ts: Date.now(), text };
    this.deps.store.appendEvent(meta.projectId, sessionId, userEvent);
    this.emit({ kind: 'transcript', sessionId, event: userEvent });

    let run = this.runs.get(sessionId);
    if (run && (run.busy || run.queue.length)) {
      run.queue.push(text);
      this.emit({ kind: 'status', sessionId, status: 'running', queue: run.queue.length });
      return;
    }
    const fresh: RunState = { abort: new AbortController(), queue: [], busy: false, interrupted: false };
    this.runs.set(sessionId, fresh);
    try {
      await this.loop(meta, fresh, text);
    } finally {
      this.runs.delete(sessionId);
    }
  }

  interrupt(sessionId: string): void {
    const run = this.runs.get(sessionId);
    if (!run) return;
    run.interrupted = true;
    run.abort.abort();
    this.deps.permissions.cancelPending();
  }

  status(sessionId: string): AgentStatus {
    const run = this.runs.get(sessionId);
    if (run) return run.busy ? 'running' : 'running';
    return this.computeIdleStatus(sessionId);
  }

  queuedCount(sessionId: string): number {
    return this.runs.get(sessionId)?.queue.length ?? 0;
  }

  // -- internals ---------------------------------------------------------------

  private computeIdleStatus(sessionId: string): AgentStatus {
    const meta = this.metaFor(sessionId);
    if (meta.mode === 'plan' && !meta.planApproved) {
      const events = this.deps.store.readEvents(meta.projectId, sessionId);
      const last = events[events.length - 1];
      if (last && (last.t === 'assistant' || last.t === 'plan')) return 'awaiting_plan';
    }
    return 'idle';
  }

  private metaFor(sessionId: string): SessionMeta {
    // Sessions are uniquely identified; find via any project is expensive, so
    // callers always come from IPC with projectId — but runtime keeps a map.
    const pid = this.projectBySession.get(sessionId);
    if (!pid) throw new Error(`Unknown session: ${sessionId}`);
    return this.deps.store.getSessionMeta(pid, sessionId);
  }

  private projectBySession = new Map<string, string>();

  /** Called by IPC layer when a session is loaded/created to register ids. */
  trackSession(projectId: string, sessionId: string): void {
    this.projectBySession.set(sessionId, projectId);
  }

  private emit(event: AgentEvent): void {
    const win = this.deps.getWindow();
    if (!win || win.isDestroyed()) return;
    const payload: AppEvent = { type: 'agent', event };
    win.webContents.send('pi:event', payload);
  }

  private persistAndEmit(meta: SessionMeta, event: TranscriptEvent): void {
    this.deps.store.appendEvent(meta.projectId, meta.id, event);
    this.emit({ kind: 'transcript', sessionId: meta.id, event });
  }

  private setStatus(meta: SessionMeta, status: AgentStatus, queue?: number): void {
    this.emit({ kind: 'status', sessionId: meta.id, status, queue });
  }

  private systemPromptFor(meta: SessionMeta): string {
    const project = this.deps.store.getProject(meta.projectId);
    return systemPrompt({
      mode: meta.mode,
      planApproved: Boolean(meta.planApproved),
      projectName: project.name,
      projectPath: project.path,
      platform: process.platform,
    });
  }

  private async loop(meta: SessionMeta, run: RunState, firstPrompt: string): Promise<void> {
    run.busy = true;
    this.setStatus(meta, 'running');
    let prompt = firstPrompt;
    try {
      do {
        try {
          await this.turn(meta, run, prompt);
        } catch (err) {
          const message = (err as Error).message ?? String(err);
          this.persistAndEmit(meta, { t: 'error', id: randomUUID(), ts: Date.now(), message });
          run.queue = [];
          break;
        }
        prompt = run.queue.shift() ?? '';
        if (prompt) {
          this.setStatus(meta, 'running', run.queue.length);
        }
      } while (prompt);
    } finally {
      run.busy = false;
      this.setStatus(meta, this.computeIdleStatus(meta.id), run.queue.length);
    }
  }

  /** One model turn: stream a completion, then execute any tool calls. */
  private async turn(meta: SessionMeta, run: RunState, _prompt: string): Promise<void> {
    const store = this.deps.store;
    const settings = this.deps.getSettings();
    const project = store.getProject(meta.projectId);
    const currentMeta = store.getSessionMeta(meta.projectId, meta.id);
    const messages = buildChatMessages(
      this.systemPromptFor(currentMeta),
      store.readEvents(currentMeta.projectId, currentMeta.id),
    );

    const modelId = currentMeta.modelId;
    if (!modelId) throw new Error('No model selected for this session. Pick one in the header.');
    const { provider: providerConfig, model, apiKey } = store.resolveModel(modelId);
    if (!apiKey) throw new Error(`No API key configured for provider "${providerConfig.name}". Add one in Settings → Models.`);

    const chat = createProvider(providerConfig, apiKey);
    const messageId = randomUUID();
    this.emit({ kind: 'message-start', sessionId: currentMeta.id, messageId });

    let text = '';
    const toolCalls: ToolCallRequest[] = [];
    try {
      for await (const chunk of chat.stream(
        {
          model: model.model,
          messages,
          tools: toolSchemas(),
          maxOutputTokens: model.maxOutputTokens,
        },
        run.abort.signal,
      )) {
        if (chunk.type === 'text-delta') {
          text += chunk.delta;
          this.emit({ kind: 'text-delta', sessionId: currentMeta.id, messageId, delta: chunk.delta });
        } else if (chunk.type === 'tool-call') {
          toolCalls.push(chunk.call);
        } else if (chunk.type === 'usage') {
          this.emit({
            kind: 'usage',
            sessionId: currentMeta.id,
            inputTokens: chunk.usage.inputTokens ?? 0,
            outputTokens: chunk.usage.outputTokens ?? 0,
          });
        }
      }
    } catch (err) {
      const aborted = run.interrupted || (err as Error).name === 'AbortError';
      if (text) {
        this.persistAndEmit(currentMeta, { t: 'assistant', id: messageId, ts: Date.now(), text, model: model.model });
      }
      if (aborted) {
        this.persistAndEmit(currentMeta, { t: 'notice', id: randomUUID(), ts: Date.now(), text: 'Interrupted by user' });
        return;
      }
      throw err;
    }

    if (text.trim()) {
      this.persistAndEmit(currentMeta, { t: 'assistant', id: messageId, ts: Date.now(), text, model: model.model });
    }

    if (!toolCalls.length) return;

    // Execute tool calls sequentially with permission gating.
    const ctx: ToolContext = { root: project.path, log: () => {} };
    for (const call of toolCalls) {
      if (run.interrupted) break;
      await this.executeTool(currentMeta, run, call, ctx, settings);
    }
  }

  private async executeTool(
    meta: SessionMeta,
    run: RunState,
    call: ToolCallRequest,
    ctx: ToolContext,
    settings: AppSettings,
  ): Promise<void> {
    const tool = toolByName(call.name);
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(call.arguments || '{}') as Record<string, unknown>;
    } catch {
      this.persistAndEmit(meta, {
        t: 'tool_result',
        id: randomUUID(),
        callId: call.id,
        ts: Date.now(),
        ok: false,
        error: `Invalid tool arguments JSON for ${call.name}`,
      });
      return;
    }

    if (!tool) {
      this.persistAndEmit(meta, {
        t: 'tool_call',
        id: call.id,
        ts: Date.now(),
        name: call.name,
        args,
        summary: call.name,
      });
      this.persistAndEmit(meta, {
        t: 'tool_result',
        id: randomUUID(),
        callId: call.id,
        ts: Date.now(),
        ok: false,
        error: `Unknown tool: ${call.name}`,
      });
      return;
    }

    this.persistAndEmit(meta, {
      t: 'tool_call',
      id: call.id,
      ts: Date.now(),
      name: tool.name,
      args,
      summary: tool.summarize(args),
    });

    const planBlocks = meta.mode === 'plan' && !meta.planApproved;
    const decision = await this.deps.permissions.check({
      sessionId: meta.id,
      tool,
      summary: tool.summarize(args),
      mode: settings.permissionMode,
      planBlocks,
    });

    if (!decision.allowed) {
      this.persistAndEmit(meta, {
        t: 'tool_result',
        id: randomUUID(),
        callId: call.id,
        ts: Date.now(),
        ok: false,
        error: decision.reason ?? 'Permission denied',
      });
      this.persistAndEmit(meta, {
        t: 'notice',
        id: randomUUID(),
        ts: Date.now(),
        text: `Tool ${tool.name} was blocked: ${decision.reason ?? 'permission denied'}`,
      });
      return;
    }

    try {
      const result = await tool.run(args, ctx);
      this.persistAndEmit(meta, {
        t: 'tool_result',
        id: randomUUID(),
        callId: call.id,
        ts: Date.now(),
        ok: result.ok,
        output: result.output,
        diff: result.diff,
        error: result.error,
        truncated: result.truncated,
      });
    } catch (err) {
      this.persistAndEmit(meta, {
        t: 'tool_result',
        id: randomUUID(),
        callId: call.id,
        ts: Date.now(),
        ok: false,
        error: (err as Error).message,
      });
    }
  }
}

interface RunState {
  abort: AbortController;
  queue: string[];
  busy: boolean;
  interrupted: boolean;
}
