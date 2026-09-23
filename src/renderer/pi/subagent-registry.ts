import type { ToolPart } from '../replica/contracts';
import type { SubagentChild, ChildState } from './subagents';

/**
 * A subagent adapter knows how to detect and parse a specific subagent
 * implementation's details structure. Community plugins can register
 * their own adapter so Desktop can display their subagent progress.
 */
export interface SubagentAdapter {
  /** Unique identifier for this adapter (e.g. 'official', 'pi-subagents'). */
  id: string;
  /** Check whether a tool part's details belong to this adapter's format. */
  detect(part: ToolPart): boolean;
  /** Extract child subagent states from the tool part. */
  parse(part: ToolPart, parentRunning: boolean): SubagentChild[];
}

const registry: SubagentAdapter[] = [];
const builtinsLoaded = false;

/** Register a subagent adapter. Last registered = highest priority. */
export function registerSubagentAdapter(adapter: SubagentAdapter) {
  // Remove any existing adapter with the same id, then add to front (highest priority).
  const idx = registry.findIndex(a => a.id === adapter.id);
  if (idx >= 0) registry.splice(idx, 1);
  registry.unshift(adapter);
}

/** Find the first adapter that detects the tool part, or undefined. */
export function findAdapter(part: ToolPart): SubagentAdapter | undefined {
  return registry.find(a => a.detect(part));
}

/** All registered adapters (for debugging / UI display). */
export function listAdapters(): SubagentAdapter[] {
  return [...registry];
}

// ---- Built-in adapters (loaded on first import) ----

const obj = (x: unknown): Record<string, any> | undefined => x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, any> : undefined;
const text = (x: unknown): string => typeof x === 'string' ? x : '';

/**
 * Official pi subagent extension adapter.
 * Parses {mode, agentScope, projectAgentsDir, results: SingleResult[]} structure.
 * Also handles pi-subagents npm package (which is a superset with the same core fields).
 */
function createOfficialAdapter(): SubagentAdapter {
  return {
    id: 'official',
    detect(part) {
      const d = obj(part.resultDetails);
      return part.tool === 'subagent' && !!d && ['single', 'parallel', 'chain'].includes(d.mode) && Array.isArray(d.results);
    },
    parse(part, parentRunning) {
      const d = obj(part.resultDetails)!;
      const children: SubagentChild[] = [];
      const callId = part.callId || part.id;
      let args: Record<string, any> = {};
      try { args = obj(JSON.parse(part.argumentsText || '{}')) ?? {}; } catch {}
      const requested = d.mode === 'chain' ? args.chain : d.mode === 'parallel' ? args.tasks : undefined;
      const size = Math.max(d.results.length, Array.isArray(requested) ? requested.length : 0);
      for (let i = 0; i < size; i++) {
        const r = obj(d.results[i]), request = obj(requested?.[i]);
        const terminal = part.phase === 'result' && part.resultDetailsFinal !== false;
        let status: ChildState;
        if (!terminal && !parentRunning) status = 'interrupted';
        else if (!r) status = terminal ? 'skipped' : parentRunning ? 'queued' : 'unknown';
        else if (part.phase === 'result' && part.resultDetailsFinal === false) status = part.status === 'error' ? 'interrupted' : !parentRunning ? 'interrupted' : 'unknown';
        else if (r.stopReason === 'aborted') status = 'interrupted';
        else if (r.stopReason === 'error' || r.errorMessage || (typeof r.exitCode === 'number' && r.exitCode > 0)) status = 'failed';
        else if (terminal) status = r.exitCode === 0 ? 'completed' : part.status === 'error' ? 'interrupted' : 'unknown';
        else if (d.mode === 'chain' && i < d.results.length - 1) status = 'completed';
        else status = parentRunning ? (r.exitCode === -1 && !r.messages?.length ? 'queued' : 'running') : 'interrupted';
        const usage = obj(r?.usage);
        children.push({
          id: `${callId}:${i}`, callId, mode: d.mode,
          agent: text(r?.agent) || text(request?.agent) || '子代理',
          task: text(r?.task) || text(request?.task),
          status, model: text(r?.model) || undefined,
          messages: Array.isArray(r?.messages) ? r.messages.filter((m: unknown) => obj(m)) : [],
          error: text(r?.errorMessage) || text(r?.stderr) || undefined,
          tokens: usage && typeof usage.input === 'number' && typeof usage.output === 'number' ? usage.input + usage.output + (usage.cacheRead || 0) + (usage.cacheWrite || 0) : undefined,
          turns: typeof usage?.turns === 'number' ? usage.turns : undefined,
          cost: typeof usage?.cost === 'number' ? usage.cost : undefined,
        });
      }
      return children;
    },
  };
}

/**
 * Generic fallback adapter: tries to extract children from ANY details
 * with a `results` array, even if the structure is unknown.
 */
function createGenericAdapter(): SubagentAdapter {
  return {
    id: 'generic',
    detect(part) {
      const d = obj(part.resultDetails);
      return part.tool === 'subagent' && !!d && ['single', 'parallel', 'chain'].includes(d.mode) && Array.isArray(d.results);
    },
    parse(part, parentRunning) {
      const d = obj(part.resultDetails)!;
      const children: SubagentChild[] = [];
      const callId = part.callId || part.id;
      const terminal = part.phase === 'result' && part.resultDetailsFinal !== false;
      for (let i = 0; i < d.results.length; i++) {
        const r = obj(d.results[i]);
        const usage = obj(r?.usage);
        children.push({
          id: `${callId}:${i}`, callId, mode: text(d.mode) || 'unknown',
          agent: text(r?.agent) || '子代理',
          task: text(r?.task) || '',
          status: terminal ? (r?.exitCode === 0 ? 'completed' : 'failed') : !parentRunning ? 'interrupted' : 'running',
          model: text(r?.model) || undefined,
          messages: Array.isArray(r?.messages) ? r.messages.filter((m: unknown) => obj(m)) : [],
          error: text(r?.errorMessage) || text(r?.stderr) || undefined,
          tokens: usage && typeof usage.input === 'number' && typeof usage.output === 'number' ? usage.input + usage.output + (usage.cacheRead || 0) + (usage.cacheWrite || 0) : undefined,
          turns: typeof usage?.turns === 'number' ? usage.turns : undefined,
          cost: typeof usage?.cost === 'number' ? usage.cost : undefined,
        });
      }
      return children;
    },
  };
}

// Register built-in adapters (generic = lowest priority, official = higher)
registerSubagentAdapter(createGenericAdapter());
registerSubagentAdapter(createOfficialAdapter());

export { createOfficialAdapter, createGenericAdapter };
