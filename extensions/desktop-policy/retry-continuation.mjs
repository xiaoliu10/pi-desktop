/** Desktop-only continuation bridge. No private AgentSession access or invented RPC commands.
 * Host owns exhaustion detection, backoff and budget; this command validates the live
 * context then uses the supported custom-message API. It never replays a user prompt.
 */
export default function retryContinuation(pi) {
  const generation = process.env.PI_DESKTOP_GENERATION;
  if (!generation) return;
  const command = `desktop-retry-${generation}`;
  let sessionFile;
  let live = false;
  const consumed = new Set();
  pi.on('session_start', (_event, ctx) => {
    sessionFile = ctx.sessionManager.getSessionFile();
    live = true;
    ctx.ui.setStatus('desktop-retry-ready', generation);
  });
  pi.on('session_shutdown', () => { live = false; consumed.clear(); });
  // Compatibility handshake for runtimes without a native agent_settled RPC event.
  // waitForIdle is a command-only API: never call it from agent_end (deadlock).
  pi.registerCommand(`${command}-settle`, {
    description: 'Desktop internal settled handshake',
    handler: async (args, ctx) => {
      const request = JSON.parse(args);
      if (!live || request.generation !== generation || request.sessionFile !== sessionFile)
        throw new Error('Stale Desktop settlement request');
      if (typeof ctx.waitForIdle !== 'function') throw new Error('Desktop runtime lacks safe waitForIdle capability');
      await ctx.waitForIdle();
      if (!live || ctx.sessionManager.getSessionFile() !== sessionFile || !ctx.isIdle() || ctx.hasPendingMessages())
        throw new Error('Desktop settlement could not be confirmed');
      ctx.ui.setStatus('desktop-retry-settled', JSON.stringify({ generation, token: request.token }));
    },
  });
  pi.registerCommand(command, {
    description: 'Desktop internal retry continuation (not a user prompt)',
    handler: (args, ctx) => {
      const request = JSON.parse(args);
      if (!live || request.generation !== generation || request.sessionFile !== sessionFile
        || ctx.sessionManager.getSessionFile() !== sessionFile) throw new Error('Stale Desktop retry session');
      if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error('Desktop retry requires a settled, empty queue');
      if (!Number.isInteger(request.group) || request.group < 2 || request.group > 10) throw new Error('Invalid Desktop retry group');
      const last = [...ctx.sessionManager.getBranch()].reverse().find(e => e.type === 'message' || e.type === 'custom_message');
      if (!last || last.id !== request.entryId || last.message?.role !== 'assistant'
        || last.message.stopReason !== 'error') throw new Error('Desktop retry context changed');
      if (consumed.has(last.id)) throw new Error('Desktop retry already dispatched');
      // No await between validation and dispatch. Consume before sending: even an
      // ambiguous host RPC timeout must never dispatch this failed entry twice.
      consumed.add(last.id);
      pi.sendMessage({
        customType: 'desktop-retry-continuation', display: false,
        content: 'The upstream request failed after its internal retries. Continue the unfinished task from the existing conversation and recorded tool results. Do not repeat completed tool operations; do not restart the original request.',
        details: { group: request.group, generation, failedEntryId: last.id },
      }, { triggerTurn: true });
    },
  });
}
