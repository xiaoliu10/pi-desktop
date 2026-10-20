import type { WorkerConfig, WorkerEvent, WorkerReply, WorkerRequest } from './index-worker-protocol';
// 进程内回退（vitest / 非 Electron）直接复用同一 worker runtime，不是第二套实现。
// 静态导入：Vite 转换下 require(entryPath) 无法加载 .ts 源；Electron 生产路径仍
// 通过 fork(entryPath) 启动独立 utility process（见 utilityTransport）。
import { createIndexWorkerRuntime } from './index-worker-entry';

/** Minimal duplex channel to the session-index process. Kept abstract so the main
 *  process can back it with Electron's `utilityProcess` while tests can drive the
 *  same client logic in-process. */
export interface IndexTransport {
  post(message: unknown): void;
  onMessage(listener: (message: unknown) => void): void;
  /** Called once when the child exits or fails to start. */
  onExit(listener: (code: number | null, reason?: string) => void): void;
  terminate(): void;
}

/** Electron `utilityProcess` backed transport. Loaded lazily so importing the index
 *  client from a plain Node/vitest context never pulls in Electron. When the Electron
 *  API is unavailable (plain Node/vitest: `require('electron')` resolves to the binary
 *  path string) it falls back to an IN-PROCESS transport running the same worker runtime
 *  module — not a second implementation. */
export function utilityTransport(config: WorkerConfig, entry?: string): IndexTransport {
  let electron: typeof import('electron') | string | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    electron = require('electron') as typeof import('electron') | string;
  } catch { electron = undefined; }
  if (electron && typeof electron !== 'string' && typeof electron.utilityProcess?.fork === 'function') {
    if (!entry) throw new Error('会话索引 worker 入口路径缺失');
    return electronTransport(electron, config, entry);
  }
  return inProcessTransport(config, entry ?? '');
}

function electronTransport(electron: typeof import('electron'), config: WorkerConfig, entry: string): IndexTransport {
  const { utilityProcess } = electron;
  const child = utilityProcess.fork(entry, [JSON.stringify(config)], { serviceName: 'PI Desktop Session Index' });
  const messageListeners: ((message: unknown) => void)[] = [];
  const exitListeners: ((code: number | null, reason?: string) => void)[] = [];
  let exited = false;
  child.on('message', (message: unknown) => { for (const listener of messageListeners) listener(message); });
  const finish = (code: number | null, reason?: string) => {
    if (exited) return;
    exited = true;
    for (const listener of exitListeners) listener(code, reason);
  };
  child.on('exit', code => finish(code));
  // A failed spawn surfaces as an 'error'-less exit on some platforms; treat the
  // absence of a live child as an exit so pending requests reject instead of hanging.
  child.on('spawn', () => undefined);
  return {
    post(message) { if (!exited) child.postMessage(message); },
    onMessage(listener) { messageListeners.push(listener); },
    onExit(listener) {
      exitListeners.push(listener);
      if (exited) listener(null, 'already exited');
    },
    terminate() { if (!exited) child.kill(); },
  };
}

/** Loads the same worker runtime module the utility process uses and wires it up with
 *  in-memory callbacks. Only for non-Electron contexts (tests). The Electron entry path
 *  is irrelevant here (the static import above is the identical module); the parameter
 *  is kept so callers have one `utilityTransport(config, entry)` signature. */
function inProcessTransport(config: WorkerConfig, _entry: string): IndexTransport {
  const messageListeners: ((message: unknown) => void)[] = [];
  const exitListeners: ((code: number | null, reason?: string) => void)[] = [];
  const queued: unknown[] = [];
  let terminated = false;
  const emit = (event: unknown) => {
    // The client registers onMessage only after spawn() returns; buffer the initial
    // snapshot/ready events and flush once a listener exists.
    if (!messageListeners.length) queued.push(event);
    else for (const listener of messageListeners) listener(event);
  };
  const runtime = createIndexWorkerRuntime(config, emit);
  const finish = (code: number | null, reason?: string) => {
    if (terminated) return;
    terminated = true;
    for (const listener of exitListeners) listener(code, reason);
  };
  return {
    post(message) {
      if (terminated) return;
      const req = message as import('./index-worker-protocol').WorkerRequest;
      if (req.op === 'shutdown') {
        try { emit({ id: req.id, ok: true, value: true }); } finally { runtime.dispose(); finish(0, 'shutdown'); }
        return;
      }
      const reply = (value: unknown) => emit({ id: req.id, ok: true, value });
      const fail = (error: unknown) => {
        const err = error as { message?: unknown; code?: unknown; name?: unknown } | undefined;
        const code = typeof err?.code === 'string' ? err.code : typeof err?.name === 'string' ? err.name : undefined;
        emit({ id: req.id, ok: false, error: { message: typeof err?.message === 'string' ? err.message : String(error), ...(code ? { code } : {}) } });
      };
      try {
        const out = runtime.handle(req);
        if (out && typeof (out as Promise<unknown>).then === 'function') void (out as Promise<unknown>).then(reply, fail);
        else reply(out);
      } catch (error) { fail(error); }
    },
    onMessage(listener) {
      messageListeners.push(listener);
      if (queued.length) {
        const pending = queued.splice(0);
        for (const message of pending) queueMicrotask(() => listener(message));
      }
    },
    onExit(listener) { exitListeners.push(listener); if (terminated) listener(null, 'already exited'); },
    terminate() { if (!terminated) { try { runtime.dispose(); } catch { /* best effort */ } finish(0, 'terminated'); } },
  };
}
