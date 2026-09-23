import { randomUUID } from 'node:crypto';
import type { PermissionMode, PermissionRequest } from '../../shared/types';
import type { ToolDef } from './tools';

/**
 * Permission layer. Privileged tools (write/exec) pass through here before
 * execution. Decisions:
 *
 *  - global default mode from settings (ask / autoEdit / fullAccess)
 *  - per-session grants the user made ("always allow in this session")
 *  - plan mode blocks privileged tools until the plan is approved
 */

export type Decision = 'allow' | 'deny';
export type UserChoice = 'allow_once' | 'allow_session' | 'deny';

export interface PermissionGate {
  /** Sends a permission prompt to the renderer and resolves with the answer. */
  ask(request: Omit<PermissionRequest, 'requestId'>): Promise<UserChoice>;
  cancelAll(): void;
}

export class PermissionService {
  private sessionGrants = new Map<string, Set<string>>();
  private pending = new Map<string, (choice: UserChoice) => void>();

  constructor(private readonly gate: PermissionGate) {}

  /**
   * Decide whether a tool invocation may proceed. Resolves when the decision
   * is known; may wait for the user via `gate.ask`.
   */
  async check(input: {
    sessionId: string;
    tool: ToolDef;
    summary: string;
    mode: PermissionMode;
    planBlocks: boolean;
  }): Promise<{ allowed: boolean; reason?: string }> {
    const { sessionId, tool, mode } = input;

    if (tool.kind === 'read') return { allowed: true };

    if (input.planBlocks) {
      return {
        allowed: false,
        reason: 'Blocked in Plan mode: approve the implementation plan before the agent can modify the project.',
      };
    }

    if (mode === 'fullAccess') return { allowed: true };
    if (mode === 'autoEdit' && tool.kind === 'write') return { allowed: true };

    const grants = this.sessionGrants.get(sessionId);
    if (grants?.has(tool.name)) return { allowed: true };

    const requestId = randomUUID();
    const choice = await this.gate.ask({ sessionId, tool: tool.name, summary: input.summary });
    if (choice === 'allow_session') {
      if (!this.sessionGrants.has(sessionId)) this.sessionGrants.set(sessionId, new Set());
      this.sessionGrants.get(sessionId)!.add(tool.name);
    }
    return choice === 'deny' ? { allowed: false, reason: 'Denied by user' } : { allowed: true };
  }

  /** Resolve every outstanding prompt (used when a run is interrupted). */
  cancelPending(): void {
    this.gate.cancelAll();
  }

  /** Track a pending prompt so an interrupt can resolve it as "deny". */
  register(requestId: string, resolve: (choice: UserChoice) => void): void {
    this.pending.set(requestId, resolve);
  }
}
