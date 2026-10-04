// Stall watchdog state machine for the Desktop subagent adapter.
// The official subagent extension finishes a child pi process on its "close"
// event; grandchild processes inheriting stdio pipes can hold that open long
// after every subagent reached a terminal state. The tool then never returns,
// no tool_execution_end is emitted, the chat card stays "running" forever and
// the main agent hangs. This module watches the progress details: once every
// result is terminal AND at least one failed, a grace timer starts; every
// further progress observation that still matches resets it, so a healthy
// sibling that merely updates slowly never gets killed. If the timer ever
// fires (no progress for the whole grace window), onStall() runs.

// pi-ai StopReason: "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred".
// Terminal = the agent loop for that subagent has ended (result is final).
const TERMINAL = new Set(['stop', 'length', 'error', 'aborted']);
const FAILED = new Set(['error', 'aborted']);

const isFinished = (r) => r && typeof r === 'object' && TERMINAL.has(r.stopReason);
const isFailed = (r) => r && typeof r === 'object' && FAILED.has(r.stopReason);

export function createStallWatchdog({ graceMs, onStall }) {
  let timer;
  let triggered = false;
  const clear = () => { if (timer) { clearTimeout(timer); timer = undefined; } };

  return {
    /** Feed one progress snapshot. Returns true when the stall timer is armed. */
    observe(results) {
      if (triggered) return false;
      const list = Array.isArray(results) ? results : [];
      const stalled = list.length > 0 && list.every(isFinished) && list.some(isFailed);
      clear();
      if (!stalled) return false;
      timer = setTimeout(() => {
        triggered = true;
        timer = undefined;
        onStall();
      }, graceMs);
      return true;
    },
    /** True once onStall has fired (guard: stop forwarding further progress). */
    get triggered() { return triggered; },
    dispose() { clear(); },
  };
}

/** Human/model-readable one-line summary of the failed results. */
export function summarizeFailures(results) {
  const list = (Array.isArray(results) ? results : []).filter(isFailed);
  return list.map(r => {
    const stderrLine = String(r.stderr ?? '').trim().split('\n')[0] ?? '';
    const detail = stderrLine || `stopReason=${r.stopReason}`;
    return `${r.agent ?? 'subagent'}: ${detail.slice(0, 160)}`;
  }).join('；');
}
