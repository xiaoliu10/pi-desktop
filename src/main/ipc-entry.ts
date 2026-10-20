/**
 * 统一 IPC 入口（`local-pi:*` 的唯一注册点）。
 *
 * 为什么单独一个模块：入口的三条不变量必须由测试钉住，而不是散在 `index.ts` 的闭包里。
 * 旧实现（d4f7d94）把校验写在业务执行之后，造成三种真实故障形态：
 *   ① 合法同步调用业务跑两遍（`fn(...args)` → 校验 → 又 `fn(...args)`）：
 *      写操作翻倍（终端开两个、归档写两次、包安装跑两遍）；
 *   ② 非法 sender / 窗口缺失时业务已经先跑了一遍才抛「非法 IPC 来源」：副作用落地，校验形同装饰；
 *   ③ 异步 handler 在 `return promise` 处提前返回，永远走不到校验行：未授权调用照样拿到结果。
 * 本模块保证：**授权先于任何业务执行；同步/异步一律严格一次；返回值与异常语义原样透传。**
 *
 * 计时（慢调用观测）是旁路：每次调用恰记录一次（含失败路径），且记录自身抛错必须被就地吞掉——
 * 观测不得影响业务，也不得在 `.then` 链上制造 unhandled rejection。
 */

/** Electron `IpcMainInvokeEvent` 的结构子集：只用到 sender / senderFrame 做同源判定。 */
export type IpcEntryEvent = { sender: unknown; senderFrame: unknown };

export type IpcEntryDeps = {
  /** 来源校验：不合法必须 throw。在任何业务执行之前调用，且只调用一次。 */
  authorize: (event: IpcEntryEvent) => void;
  /** 慢调用观测（可选）：每次调用至多一次，由调用方决定是否落盘（阈值/格式在调用方）。
   * `name` 是不带 `local-pi:` 前缀的 handler 名，保持 main-perf.log 既有口径（`ipc <name> <ms>ms`）。 */
  record?: (name: string, durationMs: number) => void;
};

const isThenable = (value: unknown): value is Promise<unknown> =>
  Boolean(value) && typeof (value as Promise<unknown>).then === 'function';

/** 包装单个 handler：授权 → 执行一次 → 计时一次。返回的监听器直接交给 ipcMain.handle。 */
export function wrapIpcHandler(
  fn: (...args: any[]) => unknown,
  deps: IpcEntryDeps & { name?: string },
): (event: IpcEntryEvent, ...args: any[]) => unknown {
  return (event, ...args) => {
    const startedAt = Date.now();
    let recorded = false;
    // 计时恰一次 + 记录失败不外溢：既不影响返回值，也不让派生 then 链变成 unhandled rejection。
    const record = () => {
      if (recorded) return;
      recorded = true;
      try { deps.record?.(deps.name ?? '', Date.now() - startedAt); } catch { /* 观测失败不影响业务 */ }
    };
    // 授权在任何业务执行之前：不合法直接 throw（Electron 会把它转成 invoke 的 rejection）。
    // 未授权路径不记时——业务从未执行，没有可观测耗时。
    deps.authorize(event);
    let result: unknown;
    try {
      result = fn(...args);
    } catch (error) {
      record();
      throw error; // 同步 throw 语义原样保留
    }
    if (isThenable(result)) {
      // 两个分支都消费（resolve/reject 都记时），派生链自身不再 reject；
      // 返回的仍是业务原始 Promise，调用方看到的 rejection 语义不变。
      void result.then(record, record);
      return result;
    }
    record();
    return result;
  };
}

export type IpcHandleFactory = (name: string, fn: (...args: any[]) => unknown) => void;

/**
 * 生成 `handle(name, fn)` 工厂：注册到 `local-pi:<name>`，每个 handler 都带上同一套授权与计时。
 * `register` 抽象掉 `ipcMain.handle`，使入口链路可以在无 Electron 的环境里被真实驱动测试。
 */
export function createIpcHandle(deps: IpcEntryDeps & {
  register: (channel: string, listener: (event: IpcEntryEvent, ...args: any[]) => unknown) => void;
}): IpcHandleFactory {
  return (name, fn) => {
    deps.register(`local-pi:${name}`, wrapIpcHandler(fn, { ...deps, name }));
  };
}
