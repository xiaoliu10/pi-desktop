import { completionsDetails, isSubagentManagement, singleAsyncDetails, workflowDetails, workflowRows, workflowState, workflowText as bounded } from '../../shared/subagent-workflow';
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
  /** Child ids must remain stable across incremental updates and reordering.
   * Legacy adapters use preallocated slots; workflows use plugin-owned keys. */
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
      return part.tool === 'subagent' && !isSubagentManagement(part.argumentsText) && !!d && ['single', 'parallel', 'chain'].includes(d.mode) && Array.isArray(d.results);
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
      return part.tool === 'subagent' && !isSubagentManagement(part.argumentsText) && !!d && ['single', 'parallel', 'chain'].includes(d.mode) && Array.isArray(d.results);
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

/** pi-subagents >=0.78 asynchronous protocols. Covers both multi-child workflow
 *  receipts and detached SINGLE runs (async launch / resume / revived), whose live
 *  state lives in `<asyncDir>/status.json` rather than in `results[]`. Tool return /
 *  parent idle do not imply child termination. Empty inventory is a workflow receipt,
 *  explicitly labelled as waiting, not an invented delegated task. */
export function createWorkflowAdapter(): SubagentAdapter {
  return {
    id: 'pi-subagents-workflow',
    detect: part => part.tool === 'subagent' && !isSubagentManagement(part.argumentsText) && (!!workflowDetails(part.resultDetails, part.callId || part.id) || !!singleAsyncDetails(part.resultDetails, part.callId || part.id) || !!completionsDetails(part.resultDetails, part.callId || part.id)),
    parse(part, parentRunning) {
      const callId = part.callId || part.id;
      const single = singleAsyncDetails(part.resultDetails, callId) ?? completionsDetails(part.resultDetails, callId);
      // Detached single run: synthesize one row until the disk snapshot (≤2s)
      // replaces it with the verified state from status.json. agent is read
      // from the launch arguments (display only); task is never reconstructed.
      if (single) {
        let args: Record<string, any> = {};
        try { args = obj(JSON.parse(part.argumentsText || '{}')) ?? {}; } catch {}
        const state = workflowState(single.state);
        // completions 形态的指针在 completions[].results[].sessionFile（run 已结束），
        // runId 用于 id 稳定性；childKey='single' 让详情面板走 completions 指针分支。
        return [{ id: `${callId}:workflow:${single.runId}:single`, callId, runId: single.runId, childKey: 'single', mode: 'workflow', agent: bounded(args.agent) || '子代理', task: '', status: state, messages: [] }];
      }
      const d = workflowDetails(part.resultDetails, callId)!;
      const rows = workflowRows(d);
      if (!rows.length) {
        const state = workflowState(d.state ?? d.workflowChildren?.workflowState);
        return [{ id: `${callId}:workflow:${d.runId}`, callId, mode: 'workflow', agent: 'Workflow', task: d.workflowChildren?.inventoryComplete === true ? '工作流尚未报告子任务' : '等待工作流报告子任务（尚未发现子代理）', status: state, messages: [] }];
      }
      return rows.map(row => {
        // Without a runId the child's claimed state can't be verified from
        // its own snapshot. Only queued is safe (no run started yet).
        const rawState = workflowState(row.state);
        const status: ChildState = !row.runId && rawState !== 'queued' ? 'unknown' : rawState;
        return {
          id: `${callId}:workflow:${d.runId}:${row.childId}`, callId, childKey: row.childId, mode: 'workflow',
          agent: bounded(row.agent) || '子代理',
          // Only explicit display labels. Never reconstruct a redacted task from
          // sessionName, a transcript, or another on-disk prompt field.
          task: bounded(row.label), status,
          model: bounded(row.model) || undefined, messages: [],
          tokens: typeof row.tokens === 'number' ? row.tokens : undefined,
          turns: typeof row.turns === 'number' ? row.turns : undefined,
        };
      });
    },
  };
}

// Register built-in adapters (generic = lowest priority, official = higher)
registerSubagentAdapter(createGenericAdapter());
registerSubagentAdapter(createOfficialAdapter());
registerSubagentAdapter(createWorkflowAdapter());

export { createOfficialAdapter, createGenericAdapter };
