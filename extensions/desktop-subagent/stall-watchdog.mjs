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
//
// 隐含不变量（reset-on-match 语义成立的前提）：pi 在全部子代理终态后不再发
// 带 results 的 update（emitUpdate 由 agent loop stdout 驱动，终态后 loop
// 立即返回、不再吐 stdout）。若未来 pi 加终态后遥测，需重新评估 reset 语义。
// 另一边角：全部子代理命中 length（截断，无 error/aborted）时不算失败、不
// 布防——此时虽收尾挂住也无失败可报，作非目标，必要时再扩 FAILED 集合。

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
    const stderr = String(r.stderr ?? '').trim().split('\n')[0];
    const detail = stderr || `stopReason=${r.stopReason}`;
    return `${r.agent ?? 'subagent'}: ${detail.slice(0, 160)}`;
  }).join('；');
}
