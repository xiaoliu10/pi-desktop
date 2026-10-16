/** Same-process, Desktop-only local model reload. This is a command, never a model tool.
 * Only public extension APIs are used; acknowledgements contain codes, never config/auth.
 */
export function registerModelRefresh(pi) {
  const generation = process.env.PI_DESKTOP_GENERATION;
  if (!generation) return;
  let live = false, sessionFile, busy = false, epoch = 0;
  const consumed = new Set();
  pi.on('session_start', (_event, ctx) => {
    sessionFile = ctx.sessionManager.getSessionFile(); live = true; ++epoch;
    const registry = ctx.modelRegistry;
    if (['refresh', 'find', 'getAvailable', 'getError'].every(k => typeof registry?.[k] === 'function')
      && ['setModel', 'getThinkingLevel', 'setThinkingLevel', 'getCommands'].every(k => typeof pi[k] === 'function')) {
      ctx.ui.setStatus('desktop-model-refresh-ready', generation);
    }
  });
  pi.on('session_shutdown', () => { live = false; ++epoch; consumed.clear(); });
  pi.on('before_agent_start', () => { ++epoch; });
  pi.on('session_before_compact', () => { ++epoch; });
  pi.registerCommand(`desktop-model-refresh-${generation}`, {
    description: 'Desktop internal local model refresh (not a user prompt)',
    handler: async (args, ctx) => {
      // Invalid/stale requests are consumed without throwing config text into extension_error.
      let request;
      try { request = JSON.parse(args); } catch { return; }
      if (!live || request.generation !== generation || request.sessionFile !== sessionFile
        || ctx.sessionManager.getSessionFile() !== sessionFile || typeof request.token !== 'string'
        || !Number.isFinite(request.deadline) || request.deadline < Date.now() || consumed.has(request.token)) return;
      consumed.add(request.token);
      // Bound replay memory; host never reuses tokens, and deadlines fence evicted old requests.
      if (consumed.size > 256) consumed.delete(consumed.values().next().value);
      const reply = (status, code) => ctx.ui.setStatus('desktop-model-refresh-result', JSON.stringify({ generation, token: request.token, status, ...(code ? { code } : {}) }));
      const startEpoch = epoch;
      const safe = () => live && epoch === startEpoch && ctx.sessionManager.getSessionFile() === sessionFile
        && Date.now() < request.deadline && ctx.isIdle() && !ctx.hasPendingMessages();
      if (busy || !safe()) { reply('pending'); return; }
      busy = true;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(0, request.deadline - Date.now()));
      try {
        const current = ctx.model;
        const thinking = pi.getThinkingLevel();
        const result = await ctx.modelRegistry.refresh({ allowNetwork: false, signal: controller.signal });
        if (!safe() || ctx.model !== current || pi.getThinkingLevel() !== thinking) { reply('pending'); return; }
        if (ctx.modelRegistry.getError() || result?.aborted || result?.errors?.size) { reply('error', 'config'); return; }
        if (current) {
          const next = ctx.modelRegistry.find(current.provider, current.id);
          if (!next) { reply('error', 'removed'); return; }
          if (!ctx.modelRegistry.getAvailable().some(m => m.provider === next.provider && m.id === next.id)) { reply('error', 'auth'); return; }
          // setModel authenticates and rebinds the *session*, not just the registry.
          // Host holds a mutation lock until readback (or reconnect on ambiguous timeout).
          if (!await pi.setModel(next)) { reply('error', 'auth'); return; }
          pi.setThinkingLevel(thinking); // kernel clamps unsupported old levels, e.g. removed max
        }
        reply('refreshed');
      } catch {
        reply('error', 'refresh'); // Never forward exception text: it may contain credentials.
      } finally { clearTimeout(timer); busy = false; }
    },
  });
}
