import os from 'node:os';
import type { SessionMode, TranscriptEvent } from '../../shared/types';
import type { ChatMessage, ToolCallRequest } from '../providers/base';

/**
 * System prompts per session mode. The three modes share one agent but differ
 * in approval boundaries, mirroring the Agent / Plan / Goal split:
 *
 *  - agent: work directly, iterating until done
 *  - plan:  research only; produce an implementation plan and stop
 *  - goal:  restate the objective and acceptance criteria, then choose the path
 */

export function systemPrompt(opts: {
  mode: SessionMode;
  projectName: string;
  projectPath: string;
  planApproved: boolean;
  platform: string;
}): string {
  const { mode, projectName, projectPath, planApproved } = opts;
  const base = [
    `You are PI Desktop, a local-first AI coding agent working inside the project "${projectName}" at ${projectPath}.`,
    `Platform: ${os.type()} ${os.release()} (${os.arch()}). Current date: ${new Date().toISOString().slice(0, 10)}.`,
    '',
    'You can use tools to explore the project, read files, edit code, and run commands.',
    'Rules:',
    '- Prefer edit_file for modifying existing files; use write_file only for new files or full rewrites.',
    '- Keep edits minimal and consistent with the surrounding code style.',
    '- After code changes, run the project’s own check/test command when one exists.',
    '- Cite file paths you worked on in your final answer.',
    '- Reply in the user’s language.',
  ].join('\n');

  if (mode === 'plan' && !planApproved) {
    return (
      base +
      '\n\nMODE: PLAN. The user wants to review your approach before any change is made.\n' +
      '- Research the repository (list_dir, read_file, grep) and, when helpful, run read-only commands.\n' +
      '- Do NOT edit files or run state-changing commands; they will be blocked.\n' +
      '- Produce a concrete implementation plan: goal, approach, files to touch, risks, and how to verify.\n' +
      '- End with a section titled "## Implementation Plan". Then stop and wait for approval.'
    );
  }
  if (mode === 'plan' && planApproved) {
    return (
      base +
      '\n\nMODE: PLAN (approved). A plan was approved by the user — implement it. ' +
      'Stay within the approved plan; if you discover it cannot work as written, say so before deviating.'
    );
  }
  if (mode === 'goal') {
    return (
      base +
      '\n\nMODE: GOAL. The user defined an outcome with acceptance criteria and delegated the path to you.\n' +
      '- Start by briefly restating the goal and your acceptance checklist.\n' +
      '- Then choose the approach and carry the work through, verifying against the criteria.\n' +
      '- Finish with an explicit statement of which criteria pass.'
    );
  }
  return base + '\n\nMODE: AGENT. Work directly: inspect, patch, run, test, and iterate until the task is done.';
}

/**
 * Convert a transcript into provider-agnostic chat history. Consecutive
 * tool_call/tool_result events are grouped into a single assistant turn with
 * tool messages, which is the shape both wire formats expect.
 */
export function buildChatMessages(system: string, events: TranscriptEvent[]): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: 'system', content: system }];
  const pendingCalls: ToolCallRequest[] = [];
  const pendingResults = new Map<string, { ok: boolean; content: string }>();

  const flushTools = () => {
    if (!pendingCalls.length) return;
    messages.push({ role: 'assistant', content: '', toolCalls: [...pendingCalls] });
    for (const call of pendingCalls) {
      const r = pendingResults.get(call.id) ?? { ok: false, content: '(no result recorded)' };
      messages.push({
        role: 'tool',
        result: { toolCallId: call.id, name: call.name, ok: r.ok, content: r.content },
      });
    }
    pendingCalls.length = 0;
    pendingResults.clear();
  };

  for (const ev of events) {
    switch (ev.t) {
      case 'user':
        flushTools();
        messages.push({ role: 'user', content: ev.text });
        break;
      case 'assistant':
        flushTools();
        messages.push({ role: 'assistant', content: ev.text });
        break;
      case 'tool_call':
        pendingCalls.push({ id: ev.id, name: ev.name, arguments: JSON.stringify(ev.args) });
        break;
      case 'tool_result':
        pendingResults.set(ev.callId, {
          ok: ev.ok,
          content: [ev.error, ev.output].filter(Boolean).join('\n') || '(empty)',
        });
        break;
      case 'error':
        flushTools();
        messages.push({ role: 'user', content: `[runtime error] ${ev.message}` });
        break;
      case 'notice':
        flushTools();
        messages.push({ role: 'user', content: `[notice] ${ev.text}` });
        break;
      case 'plan':
        flushTools();
        messages.push({
          role: 'user',
          content:
            ev.status === 'approved'
              ? '[notice] The implementation plan was approved by the user.'
              : '[notice] A plan was proposed.',
        });
        break;
    }
  }
  flushTools();
  return messages;
}
