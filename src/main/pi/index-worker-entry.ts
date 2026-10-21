import { SessionIndex } from './session-index';
import { OutlineCache } from './outline-cache';
import { recoverSubagents, subagentChildTranscript } from './official-subagent';
import { RendererHistory } from './renderer-history';
import type { PiEntry, PiSession } from '../../shared/pi';
import type { WorkerConfig, WorkerEvent, WorkerReply, WorkerRequest } from './index-worker-protocol';

/** 镜像尾窗预算。主进程同步镜像读的消费方窗口：backend 四处 ≤ 64 条（settle 1 /
 *  压缩留痕 64 / 重试条目 64/8），sidecar 摘要 256 条。条目数保底（64 条无条件镜像）
 *  之后才受字节预算约束——字节裁剪掉的尾部窗口由 client 用 total fail-closed，不静默少回。 */
const TAIL_ENTRIES = 256;
const TAIL_BYTES = 4 * 1024 * 1024;
const TAIL_FLOOR_ENTRIES = 64;
/** 单条镜像条目的序列化上限：投影（裁 base64/超长文本）后仍超限的条目只镜像骨架
 *  {type,id,parentId,timestamp,customType} + 长度标记——主进程三处同步查找只需要
 *  身份与时间戳，12MB 的单条 toolResult 不能把整窗预算吃光（实测 p15 镜像=12MB）。 */
const MIRROR_ENTRY_BYTES = 16 * 1024;
/** 镜像内文本块的单块上限。镜像只用于：找条目身份、读时间戳、sidecar 摘要文本
 *  （每条 ≤600 字），长文本过界纯属浪费；截断必须带标记，不得静默。 */
const MIRROR_TEXT_CAP = 4_000;

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
 *  process keeps bounded mirrors (metadata + an entry-floored, byte-capped branch-tail
 *  window). */
export function createIndexWorkerRuntime(config: WorkerConfig, emit: (event: WorkerEvent) => void): IndexWorkerHandle {
  const outlines = new OutlineCache(config.outlineCachePath);
  const index = new SessionIndex(config.roots, config.ownedRoot, outlines);
  const rendererHistory = new RendererHistory();
  const subscribed = new Set<string>();
  const mirrorEntries = new WeakMap<PiEntry, PiEntry>();

  const pushTail = (key: string) => {
    let tail: PiEntry[];
    // 当前读不到（新会话文件尚未创建/尚未被扫描到）不是退订理由：保留订阅，
    // 下一次 changed → pushSessions 会再推；删掉会让懒创建文件的新会话永远收不到尾窗。
    try {
      tail = index.branchTail(key, TAIL_ENTRIES);
      emit({ ev: 'tail', key, tail: trimMirrorWindow(tail, mirrorEntries), total: index.branchLength(key) });
    } catch {
      // 删除/超限/不可读都明确使主进程镜像失效。空尾窗带 unavailable 标记，
      // client 删除镜像后同步读抛 IndexUnavailableError；不把失败当成「有效空会话」。
      // 保留订阅，文件落地/恢复后下次 changed 会重新填充。
      emit({ ev: 'tail', key, tail: [], total: 0, unavailable: true });
      return;
    }
  };
  // 元数据快照：check 的增量维护保证 cache 新鲜，sessionsView 即够。全量 walk 只在
  // forkCopySource 之后（新副本文件要立刻被发现）做——changed 每 120ms 一拍，每拍全量
  // walk 实测吃掉 worker 15-40% 一核（300 文件 warm scan 17.6-25ms/次）。
  const pushSessions = (full = false) => {
    const sessions: PiSession[] = full ? index.scan(true) : index.sessionsView(true);
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
        case 'history': {
          // 不变量在 worker 侧强制：出线 entries 一律收敛到 branch（渲染层对 entries 零
          // 消费）。全量无损 entries 绝不跨进程回主进程——包括调用方忘了传 tail 的时候；
          // 需要全量的内部消费方走专用 op（forkCopySource 已是该模式）。
          const full = index.history(req.key, req.leaf, { tail: req.before === undefined ? (req.tail ?? 500) : req.tail, before: req.before, count: req.count });
          return rendererHistory.project(full.entries === full.branch ? full : { ...full, entries: full.branch });
        }
        case 'branchTail': {
          // 事件时刻的 owner 读先增量解析，再投影（真值身份/时间戳不变，base64 不过界）。
          const branch = index.branchTail(req.key, req.n);
          const projected = trimMirrorWindow(branch, mirrorEntries);
          if (projected.length !== branch.length) throw new Error('Owner branch window exceeds transport budget');
          return projected;
        }
        case 'usageStats':
          // 聚合在 worker 内完成（按需读文件），只回聚合结果：主进程不做任何会话文件 IO。
          return index.usageStatsAsync(req.now === undefined ? undefined : new Date(req.now));
        case 'remotePage':
          // 与 SessionIndex.remotePage 同一实现：history() 抛错（超限/不可读）时回 null，
          // HTTP 层据此回 404，不把异常当成空页。分页 branch 过同一套传输投影
          // （手机端 viewer 不渲染 base64，24MB 的截图页没理由过界）。
          return index.remotePage(req.key, req.before, req.page).then(page => {
            if (!page) return null;
            return { ...page, branch: rendererHistory.projectPage(page.branch) };
          }).catch(() => null);
        case 'forkCopySource': {
          // 全量无损 entries 不出 worker：直接在 worker 内把副本写到 targetPath。
          const copied = index.forkCopySource(req.key, req.targetPath, req.header);
          // 副本是新会话文件：应答前先推 sessions/tail 镜像（消息保序），主进程
          // await 返回后立即 sessionMeta/scan 就能看到它（与旧 history() 按需扫描等价）。
          // 新副本要立刻被发现，这里用一次全量 walk（见 pushSessions 注释）。
          pushSessions(true);
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

/** 镜像尾窗裁剪：条目数保底 + 字节预算 + 传输投影。
 *
 *  1) 投影先行：图片 base64 按 RendererHistory 同款裁掉（记录 omittedBase64Chars），
 *     超长文本块截断并标记 mirrorTruncatedChars——镜像只被用来找条目身份、读时间戳、
 *     sidecar 摘要（每条 ≤600 字），base64/长文本过界纯属浪费（真实会话 195MB base64，
 *     2-3 条大图就能把整个字节预算吃光，让所有窗口退化成「最新 1-3 条」）。
 *  2) 条目数保底：最新的 TAIL_FLOOR_ENTRIES 条无条件保留（消费方最大窗口 64 条），
 *     超出部分才受 TAIL_BYTES 约束。
 *  3) 单条超预算：投影后仍超 MIRROR_ENTRY_BYTES 的条目只镜像骨架（身份 + 时间戳 +
 *     长度标记），不拖垮整窗。窗口仍不够时由 client 用 total fail-closed，不静默少回。 */
function trimMirrorWindow(entries: PiEntry[], memo: WeakMap<PiEntry, PiEntry>): PiEntry[] {
  let used = 0;
  const out: PiEntry[] = [];
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]!;
    const cached = memo.get(entry);
    const originalSize = cached ? 0 : Buffer.byteLength(JSON.stringify(entry), 'utf8');
    const projected = cached ?? projectForMirror(entry);
    let size = 0;
    try { size = Buffer.byteLength(JSON.stringify(projected), 'utf8'); } catch { size = 0; }
    let keep = projected;
    if (size > MIRROR_ENTRY_BYTES || originalSize > TAIL_BYTES) {
      keep = {
        type: projected.type, id: projected.id, parentId: projected.parentId,
        timestamp: projected.timestamp, customType: projected.customType,
        mirrorSkeletonChars: originalSize,
      } as PiEntry;
      try { size = Buffer.byteLength(JSON.stringify(keep), 'utf8'); } catch { size = 0; }
    }
    // 畸形超长身份字段连骨架也装不下时不可裁身份（会返回伪造 id）：使整个窗口不可用。
    if (size > MIRROR_ENTRY_BYTES) throw new Error('Mirror identity exceeds transport budget');
    memo.set(entry, keep);
    if (out.length >= TAIL_FLOOR_ENTRIES && used + size + out.length + 2 > TAIL_BYTES) break;
    used += size;
    out.push(keep);
  }
  return out.reverse();
}

/** 镜像投影（与 RendererHistory 的传输投影同口径）：toolResult 图片裁 base64，
 *  文本块超长截断。截断/裁剪一律带标记，镜像不是无损数据源，不得静默。 */
function projectForMirror(entry: PiEntry): PiEntry {
  const message = entry.message as { role?: unknown; content?: unknown } | undefined;
  const content = message?.content;
  if (!message) return entry;
  let changed = false;
  const capString = (text: string): string => {
    if (text.length <= MIRROR_TEXT_CAP) return text;
    changed = true;
    return text.slice(0, MIRROR_TEXT_CAP);
  };
  let nextContent: unknown = content;
  if (typeof content === 'string') {
    nextContent = capString(content);
  } else if (Array.isArray(content)) {
    const blocks = (content as unknown[]).map(block => {
      if (typeof block === 'string') return capString(block);
      if (!block || typeof block !== 'object') return block;
      const b = block as Record<string, unknown>;
      if (b.type === 'image' && typeof b.data === 'string') {
        changed = true;
        const { data, ...metadata } = b;
        return { ...metadata, omittedBase64Chars: data.length };
      }
      if (typeof b.text === 'string' && b.text.length > MIRROR_TEXT_CAP) {
        changed = true;
        return { ...b, text: b.text.slice(0, MIRROR_TEXT_CAP), mirrorTruncatedChars: b.text.length - MIRROR_TEXT_CAP };
      }
      return block;
    });
    nextContent = changed ? blocks : content;
  }
  return changed ? {
    ...entry,
    message: { ...message, content: nextContent,
      ...(typeof content === 'string' && content.length > MIRROR_TEXT_CAP ? { mirrorTruncatedChars: content.length - MIRROR_TEXT_CAP } : {}) },
  } : entry;
}

function errorPayload(error: unknown): { message: string; code?: string } {
  const err = error as { message?: unknown; code?: unknown; name?: unknown } | undefined;
  const code = typeof err?.code === 'string' ? err.code : typeof err?.name === 'string' ? err.name : undefined;
  return { message: typeof err?.message === 'string' ? err.message : String(error), ...(code ? { code } : {}) };
}

/** Electron utility process 的 parentPort 是 MessagePortMain：'message' 回调收到
 *  MessageEvent { data, ports }，裸消息在 data 里（与 renderer MessagePort 同语义）；
 *  而 Node child_process 的 process.on('message') 直接给裸消息。0.1.32 打包环境实测：
 *  main→child 方向有包装、child→main 方向是裸值（非对称）。协议消息必有 id（请求/应答）
 *  或 ev（出站事件），{data,ports} 包装没有 id/ev——据此判定并解包，通道层归一为裸消息。 */
function unwrapPortMessage(raw: unknown): unknown {
  if (raw && typeof raw === 'object' && 'data' in raw && !('id' in raw) && !('ev' in raw)) {
    return (raw as { data: unknown }).data;
  }
  return raw;
}

/** 双工通道：Electron utility process 用 `process.parentPort`；普通 Node 子进程
 *  （`child_process.fork`，用于测试与真实性能探针）用 IPC 的 `process.send`。
 *  两者语义一致（结构化克隆 + 'message' 事件），入站形状由 unwrapPortMessage 归一，
 *  所以下面的协议处理完全共用。 */
function duplexChannel(): { postMessage(v: unknown): void; on(event: 'message', cb: (v: unknown) => void): void } | undefined {
  const parentPort = (process as unknown as { parentPort?: { postMessage(v: unknown): void; on(event: 'message', cb: (v: unknown) => void): void } }).parentPort;
  if (parentPort) return {
    postMessage: (v: unknown) => parentPort.postMessage(v),
    on: (_event: 'message', cb: (v: unknown) => void) => parentPort.on('message', (raw: unknown) => cb(unwrapPortMessage(raw))),
  };
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
