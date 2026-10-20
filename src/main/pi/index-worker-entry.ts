import { SessionIndex } from './session-index';
import { OutlineCache } from './outline-cache';
import { recoverSubagents, subagentChildTranscript } from './official-subagent';
import { RendererHistory } from './renderer-history';
import type { PiEntry, PiSession } from '../../shared/pi';
import type { WorkerConfig, WorkerEvent, WorkerReply, WorkerRequest } from './index-worker-protocol';

/** Byte budget for the branch window mirrored into the main process. The three
 *  synchronous main-side lookups (settle timestamp, compaction record, retry entry)
 *  all read near the branch tip, so a bounded window is sufficient — and keeping it
 *  byte-capped stops base64 images in large sessions from being cloned on every append. */
const TAIL_ENTRIES = 256;
const TAIL_BYTES = 4 * 1024 * 1024;

export interface IndexWorkerHandle {
  index: SessionIndex;
  handle(req: WorkerRequest): unknown;
  dispose(): void;
}

/** Hosts everything that used to block the Electron main thread: filesystem walks,
 *  session parsing, branch maintenance, outline/search aggregation, subagent
 *  recovery, and derived session-file writes (fork-copy).
 *
 *  Responsibility boundary: this worker is the ONLY process that holds full, lossless
 *  session entries. The main process must never receive them — `history` replies are
 *  tail-capped and transport-projected (toolResult image base64 stripped), `remotePage`
 *  replies are one `HISTORY_PAGE_SIZE`-bounded page, search/outline/subagent results are
 *  bounded aggregates, and `forkCopySource` serialises the full entries straight to disk
 *  in here and returns only `{ path, entries }`. `emit` is the only way out; the main
 *  process keeps bounded mirrors (metadata + a byte-capped branch-tail window). */
export function createIndexWorkerRuntime(config: WorkerConfig, emit: (event: WorkerEvent) => void): IndexWorkerHandle {
  const outlines = new OutlineCache(config.outlineCachePath);
  const index = new SessionIndex(config.roots, config.ownedRoot, outlines);
  const rendererHistory = new RendererHistory();
  const subscribed = new Set<string>();

  const pushTail = (key: string) => {
    let tail: PiEntry[];
    // 当前读不到（新会话文件尚未创建/尚未被扫描到）不是退订理由：保留订阅，
    // 下一次 changed → pushSessions 会再推；删掉会让懒创建文件的新会话永远收不到尾窗。
    try { tail = index.branchTail(key, TAIL_ENTRIES); } catch { return; }
    emit({ ev: 'tail', key, tail: trimBytes(tail), total: index.branchLength(key) });
  };
  const pushSessions = () => {
    const sessions: PiSession[] = index.scan(true);
    emit({ ev: 'sessions', sessions });
    for (const key of [...subscribed]) pushTail(key);
  };

  index.start(() => {
    pushSessions();
    emit({ ev: 'changed' });
  });
  // SessionIndex.start() primes its cache synchronously, so this first snapshot is exact.
  pushSessions();
  emit({ ev: 'ready' });

  return {
    index,
    handle(req: WorkerRequest): unknown {
      switch (req.op) {
        case 'history':
          return rendererHistory.project(index.history(req.key, req.leaf, { tail: req.tail, before: req.before, count: req.count }));
        case 'remotePage':
          // 与 SessionIndex.remotePage 同一实现：history() 抛错（超限/不可读）时回 null，
          // HTTP 层据此回 404，不把异常当成空页。
          return index.remotePage(req.key, req.before, req.page).catch(() => null);
        case 'forkCopySource': {
          // 全量无损 entries 不出 worker：直接在 worker 内把副本写到 targetPath。
          const copied = index.forkCopySource(req.key, req.targetPath, req.header);
          // 副本是新会话文件：应答前先推 sessions/tail 镜像（消息保序），主进程
          // await 返回后立即 sessionMeta/scan 就能看到它（与旧 history() 按需扫描等价）。
          pushSessions();
          return copied;
        }
        case 'search':
          return index.searchSession(req.key, req.query, { limit: req.limit });
        case 'outline':
          return index.sessionOutline(req.key);
        case 'recoverSubagents':
          return recoverSubagents(config.agentDir, req.key, index, req.leaf, req.pinned, req.knownSignature);
        case 'subagentChildTranscript':
          return subagentChildTranscript(config.agentDir, req.key, index, req.callId, req.childId);
        case 'subscribe':
          subscribed.add(req.key);
          pushTail(req.key);
          return true;
        case 'unsubscribe':
          subscribed.delete(req.key);
          return true;
        case 'shutdown':
          return true;
      }
    },
    dispose() {
      subscribed.clear();
      index.close();
      outlines.flushNow();
    },
  };
}

/** Keep the newest entries whose serialized size fits the budget. JSON length is a
 *  cheap proxy dominated by the text/base64 payloads that actually drive the cost. */
function trimBytes(entries: PiEntry[]): PiEntry[] {
  let used = 0;
  const out: PiEntry[] = [];
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]!;
    let size = 0;
    try { size = JSON.stringify(entry)?.length ?? 0; } catch { size = 0; }
    if (out.length && used + size > TAIL_BYTES) break;
    used += size;
    out.push(entry);
  }
  return out.reverse();
}

function errorPayload(error: unknown): { message: string; code?: string } {
  const err = error as { message?: unknown; code?: unknown; name?: unknown } | undefined;
  const code = typeof err?.code === 'string' ? err.code : typeof err?.name === 'string' ? err.name : undefined;
  return { message: typeof err?.message === 'string' ? err.message : String(error), ...(code ? { code } : {}) };
}

/** 双工通道：Electron utility process 用 `process.parentPort`；普通 Node 子进程
 *  （`child_process.fork`，用于测试与真实性能探针）用 IPC 的 `process.send`。
 *  两者语义一致（结构化克隆 + 'message' 事件），所以下面的协议处理完全共用。 */
function duplexChannel(): { postMessage(v: unknown): void; on(event: 'message', cb: (v: unknown) => void): void } | undefined {
  const parentPort = (process as unknown as { parentPort?: { postMessage(v: unknown): void; on(event: 'message', cb: (v: unknown) => void): void } }).parentPort;
  if (parentPort) return parentPort;
  const send = (process as unknown as { send?: (v: unknown) => boolean }).send;
  if (typeof send === 'function') {
    return {
      postMessage: (v: unknown) => { send.call(process, v); },
      on: (_event: 'message', cb: (v: unknown) => void) => { process.on('message', cb as (v: unknown) => void); },
    };
  }
  return undefined;
}

/** 配置发现：不依赖固定的 argv 下标。`utilityProcess.fork` 与 `child_process.fork`
 *  给子进程的 argv 形状不同（前者不含模块路径），写死下标会在其中一个宿主里静默
 *  拿到 undefined 并报「配置无效」。这里取第一个能解析成合法配置形状的 argv。 */
function readConfig(argv: string[]): WorkerConfig | undefined {
  for (const arg of argv) {
    if (typeof arg !== 'string' || !arg.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(arg) as WorkerConfig;
      if (parsed && Array.isArray(parsed.roots) && typeof parsed.ownedRoot === 'string'
        && typeof parsed.agentDir === 'string' && typeof parsed.outlineCachePath === 'string') return parsed;
    } catch { /* 不是配置 JSON，继续找下一个 argv */ }
  }
  return undefined;
}

/** Worker entry: config arrives as a JSON argv entry, requests over the duplex channel. */
function main(): void {
  // 见文件末尾的 bootstrap 守卫：只有真正的 worker 宿主才进入 main()。
  const parentPort = duplexChannel();
  const send = (message: WorkerReply | WorkerEvent) => parentPort?.postMessage(message);
  if (!parentPort) return;
  let handle: IndexWorkerHandle;
  try {
    const config = readConfig(process.argv);
    if (!config) {
      send({ ev: 'fatal', message: '会话索引 worker 配置无效' });
      return;
    }
    handle = createIndexWorkerRuntime(config, send);
  } catch (error) {
    send({ ev: 'fatal', message: (error as Error)?.message ?? String(error) });
    return;
  }
  parentPort.on('message', (raw: unknown) => {
    const req = raw as WorkerRequest;
    if (!req || typeof req.id !== 'number' || typeof req.op !== 'string') return;
    if (req.op === 'shutdown') {
      send({ id: req.id, ok: true, value: true });
      handle.dispose();
      process.exit(0);
    }
    try {
      const value = handle.handle(req);
      if (value && typeof (value as Promise<unknown>).then === 'function') {
        void (value as Promise<unknown>).then(
          resolved => send({ id: req.id, ok: true, value: resolved }),
          error => send({ id: req.id, ok: false, error: errorPayload(error) }),
        );
      } else {
        send({ id: req.id, ok: true, value });
      }
    } catch (error) {
      send({ id: req.id, ok: false, error: errorPayload(error) });
    }
  });
}

/** Bootstrap 守卫：本模块同时被 index-transport 静态导入（进程内回退复用同一份 runtime
 *  实现），所以模块加载本身不得产生副作用。只有真正的 worker 宿主才启动协议循环：
 *  Electron utility process 有 process.parentPort；普通 Node 子进程（child_process.fork
 *  的测试与性能探针）由启动方显式设置 PI_INDEX_WORKER=1。
 *  少了这道守卫时，vitest 的 tinypool worker 同样有 process.send，本模块会去应答 vitest
 *  自己的内部 IPC 消息，把测试进程打挂（实测 ERR_INVALID_ARG_TYPE / Unhandled Rejection）。 */
const isWorkerHost = Boolean((process as unknown as { parentPort?: unknown }).parentPort)
  || process.env.PI_INDEX_WORKER === '1';
if (isWorkerHost) main();
