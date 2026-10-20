import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createIpcHandle, wrapIpcHandler } from '../src/main/ipc-entry';

// 统一 IPC 入口的语义钉子（R-render-01：主进程热路径不得重复干活）：
// 旧实现（d4f7d94）在 src/main/index.ts 的 handle 里先 fn(...args) 跑一遍业务、再校验来源、
// 校验通过后又跑第二遍；异步 handler 因为「提前 return promise」直接绕过校验。后果：
//   ① 合法同步调用业务执行两次（写操作翻倍：终端创建两个、归档写两次、安装跑两遍）；
//   ② 非法 sender / 窗口缺失时业务仍然执行了一次（副作用先落地，才抛「非法 IPC 来源」）；
//   ③ 非法 sender 的异步调用完全绕过校验，正常拿到返回值（未授权读写全部可用）；
//   ④ 慢调用计时只覆盖第一次执行，观测口径与真实耗时不符。
// 旧形态的真实复现见 CHANGELOG 与 PR 描述；本文件钉住修复后的契约：
//   - 授权在任何业务执行之前，同步/异步一律严格一次（不多跑、不漏跑、不绕过）；
//   - 同步值 / Promise 返回 / throw / rejection 四种语义原样透传；
//   - 计时恰一次（含失败路径），且计时记录自身抛错不得影响业务、不得制造 unhandled rejection。
//
// 行为测试用「真 handler mock」：被测对象是 index.ts 实际使用的同一个 createIpcHandle 工厂，
// 注入假 ipcMain/假 authorize，覆盖注册 → 授权 → 执行 → 计时的完整链路，而不是孤立函数。

type Recorded = { name: string; ms: number };

/** 假 ipcMain：只收集注册，测试直接调用监听器（与 Electron 的 (event, ...args) 契约一致）。 */
function fakeIpcMain() {
  const registered = new Map<string, (event: any, ...args: any[]) => unknown>();
  return {
    registered,
    register: (channel: string, listener: (event: any, ...args: any[]) => unknown) => {
      if (registered.has(channel)) throw new Error(`通道重复注册: ${channel}`);
      registered.set(channel, listener);
    },
    invoke: (channel: string, event: any, ...args: any[]) => registered.get(channel)!(event, ...args),
  };
}

/** 假窗口：mainWindow.webContents / mainFrame 与 event.sender / senderFrame 的身份对照。 */
function fakeWindow() {
  const mainFrame = { id: 1 };
  const webContents = { mainFrame };
  const window = { webContents };
  const legalEvent = { sender: webContents, senderFrame: mainFrame };
  // 真实 authorize 判定式与 index.ts 逐字一致（窗口缺失 / sender 不符 / frame 不符三种拒绝）
  const authorize = (event: { sender: unknown; senderFrame: unknown }) => {
    const win: any = currentWindow();
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('非法 IPC 来源');
  };
  let win: any = window;
  const currentWindow = () => win;
  return { window, legalEvent, authorize, mainFrame, webContents, setWindow: (w: any) => { win = w; } };
}

function setup() {
  const ipc = fakeIpcMain();
  const win = fakeWindow();
  const records: Recorded[] = [];
  const handle = createIpcHandle({
    register: ipc.register,
    authorize: win.authorize,
    record: (name, ms) => { records.push({ name, ms }); },
  });
  return { ipc, win, records, handle };
}

const tick = () => new Promise(r => setImmediate(r));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** 收集本轮微任务/宏任务期间的 unhandledRejection（计时链或 handler 链漏 catch 会在这里暴露）。 */
async function captureUnhandledRejections(body: () => Promise<void> | void) {
  const seen: unknown[] = [];
  const onUnhandled = (reason: unknown) => { seen.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try { await body(); await tick(); await sleep(5); await tick(); } finally { process.off('unhandledRejection', onUnhandled); }
  return seen;
}

describe('统一 IPC 入口：授权在任何业务执行之前，且严格一次', () => {
  it('合法同步调用：业务恰好一次，返回值原样透传', () => {
    const { ipc, win, handle } = setup();
    const fn = vi.fn((a: number, b: number) => a + b);
    handle('sum', fn);
    expect(ipc.registered.has('local-pi:sum')).toBe(true);
    expect(ipc.invoke('local-pi:sum', win.legalEvent, 2, 3)).toBe(5);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(2, 3); // 参数按序透传，不吞不重排
  });

  it('合法异步调用：业务恰好一次，返回同一个 Promise，值原样', async () => {
    const { ipc, win, handle } = setup();
    let calls = 0;
    const promise = Promise.resolve('payload');
    handle('asyncOk', () => { calls++; return promise; });
    const returned = ipc.invoke('local-pi:asyncOk', win.legalEvent);
    expect(returned, '必须原样返回业务的 Promise（不包装成新值）').toBe(promise);
    await expect(returned as Promise<string>).resolves.toBe('payload');
    expect(calls).toBe(1);
  });

  it('非法 sender（同步 handler）：业务零执行，抛「非法 IPC 来源」', () => {
    const { ipc, handle } = setup();
    const fn = vi.fn(() => 'ok');
    handle('syncGuarded', fn);
    expect(() => ipc.invoke('local-pi:syncGuarded', { sender: { attacker: true }, senderFrame: { evil: true } }))
      .toThrow('非法 IPC 来源');
    expect(fn).not.toHaveBeenCalled();
  });

  it('非法 sender（异步 handler）：不再绕过校验，业务零执行且不返回结果', async () => {
    const { ipc, handle } = setup();
    const sideEffects: string[] = [];
    handle('asyncGuarded', async () => { await sleep(1); sideEffects.push('written'); return 'secret'; });
    // 旧实现在这里会 return 业务的 promise：未授权也能拿到 'secret' 并落地副作用。
    await expect(async () => ipc.invoke('local-pi:asyncGuarded', { sender: { attacker: true }, senderFrame: { evil: true } }))
      .rejects.toThrow('非法 IPC 来源');
    await sleep(5);
    expect(sideEffects).toEqual([]);
  });

  it('非法 senderFrame（sender 正确但 frame 不是主 frame）：业务零执行', () => {
    const { ipc, win, handle } = setup();
    const fn = vi.fn(() => 'ok');
    handle('frameGuarded', fn);
    expect(() => ipc.invoke('local-pi:frameGuarded', { sender: win.webContents, senderFrame: { id: 999 } }))
      .toThrow('非法 IPC 来源');
    expect(fn).not.toHaveBeenCalled();
  });

  it('窗口缺失（mainWindow=null，如启动中/已关闭）：业务零执行', () => {
    const { ipc, win, handle } = setup();
    const fn = vi.fn(() => 'ok');
    handle('noWindow', fn);
    win.setWindow(null);
    expect(() => ipc.invoke('local-pi:noWindow', { sender: win.webContents, senderFrame: win.mainFrame }))
      .toThrow('非法 IPC 来源');
    expect(fn).not.toHaveBeenCalled();
  });

  it('每个通道只注册一次，且注册名带 local-pi: 前缀', () => {
    const { ipc, handle } = setup();
    handle('alpha', () => 1);
    handle('beta', () => 2);
    expect([...ipc.registered.keys()]).toEqual(['local-pi:alpha', 'local-pi:beta']);
    expect(() => handle('alpha', () => 3)).toThrow(/通道重复注册/);
  });
});

describe('统一 IPC 入口：返回/异常语义原样保留', () => {
  it('同步 throw：原错误对象同步抛出，不被吞成 undefined', () => {
    const { ipc, win, handle } = setup();
    const boom = new Error('业务失败');
    handle('syncThrow', () => { throw boom; });
    expect(() => ipc.invoke('local-pi:syncThrow', win.legalEvent)).toThrow(boom);
  });

  it('异步 rejection：返回的 Promise 以同一错误 reject', async () => {
    const { ipc, win, handle } = setup();
    const boom = new Error('异步失败');
    handle('asyncThrow', async () => { await sleep(1); throw boom; });
    const unhandled = await captureUnhandledRejections(async () => {
      const returned = ipc.invoke('local-pi:asyncThrow', win.legalEvent) as Promise<unknown>;
      await expect(returned).rejects.toBe(boom);
    });
    expect(unhandled, '业务 rejection 必须被调用方（Electron）消费，不得泄漏成 unhandledRejection').toEqual([]);
  });

  it('同步返回 undefined / falsy / thenable 对象都不被误判成 Promise', async () => {
    const { ipc, win, handle } = setup();
    handle('voidish', () => undefined);
    handle('zero', () => 0);
    handle('thenable', () => ({ then: 'not-a-function' }));
    expect(ipc.invoke('local-pi:voidish', win.legalEvent)).toBeUndefined();
    expect(ipc.invoke('local-pi:zero', win.legalEvent)).toBe(0);
    const thenable = ipc.invoke('local-pi:thenable', win.legalEvent) as { then: string };
    expect(thenable.then).toBe('not-a-function'); // 原对象原样返回，不当 promise 处理
  });
});

describe('统一 IPC 入口：计时恰一次，且记录失败不破坏业务', () => {
  it('成功/失败/异步四条路径都恰好记录一次，带 handler 名（不带 local-pi: 前缀，与 main-perf.log 口径一致）', async () => {
    const { ipc, win, records, handle } = setup();
    handle('okSync', () => 'v');
    handle('throwSync', () => { throw new Error('x'); });
    handle('okAsync', async () => { await sleep(2); return 'v'; });
    handle('rejectAsync', async () => { await sleep(2); throw new Error('x'); });

    ipc.invoke('local-pi:okSync', win.legalEvent);
    try { ipc.invoke('local-pi:throwSync', win.legalEvent); } catch { /* 预期 */ }
    const p1 = ipc.invoke('local-pi:okAsync', win.legalEvent) as Promise<unknown>;
    const p2 = ipc.invoke('local-pi:rejectAsync', win.legalEvent) as Promise<unknown>;
    await p1;
    await expect(p2).rejects.toThrow('x');
    await tick();

    expect(records.map(r => r.name)).toEqual(['okSync', 'throwSync', 'okAsync', 'rejectAsync']);
    expect(records.every(r => typeof r.ms === 'number' && r.ms >= 0)).toBe(true);
    expect(records.find(r => r.name === 'okAsync')!.ms).toBeGreaterThanOrEqual(2); // 计时覆盖完整异步耗时
  });

  it('同一异步调用只记录一次（不在 resolve 与 then 链上重复记）', async () => {
    const { ipc, win, records, handle } = setup();
    handle('once', async () => { await sleep(1); return 1; });
    const p = ipc.invoke('local-pi:once', win.legalEvent) as Promise<unknown>;
    await p; await p; // 调用方多次 await 同一个 promise
    await tick();
    expect(records).toHaveLength(1);
  });

  it('未授权调用不记录计时（业务从未执行，无耗时可记）', () => {
    const { ipc, records, handle } = setup();
    handle('denied', async () => 'secret');
    expect(() => ipc.invoke('local-pi:denied', { sender: {}, senderFrame: {} })).toThrow('非法 IPC 来源');
    expect(records).toEqual([]);
  });

  it('record 自身抛错：业务返回值/异常语义不受影响，且不产生 unhandled rejection', async () => {
    const ipc = fakeIpcMain();
    const win = fakeWindow();
    const handle = createIpcHandle({
      register: ipc.register,
      authorize: win.authorize,
      record: () => { throw new Error('perf 日志盘满'); },
    });
    handle('sync', () => 'value');
    handle('syncThrow', () => { throw new Error('原始业务错误'); });
    handle('async', async () => { await sleep(1); return 'async-value'; });
    handle('asyncThrow', async () => { await sleep(1); throw new Error('原始异步错误'); });

    const unhandled = await captureUnhandledRejections(async () => {
      expect(ipc.invoke('local-pi:sync', win.legalEvent)).toBe('value');
      expect(() => ipc.invoke('local-pi:syncThrow', win.legalEvent)).toThrow('原始业务错误');
      await expect(ipc.invoke('local-pi:async', win.legalEvent) as Promise<unknown>).resolves.toBe('async-value');
      await expect(ipc.invoke('local-pi:asyncThrow', win.legalEvent) as Promise<unknown>).rejects.toThrow('原始异步错误');
    });
    expect(unhandled, '计时链抛错必须被就地吞掉').toEqual([]);
  });
});

describe('wrapIpcHandler：与 createIpcHandle 同一份语义（单元级）', () => {
  it('授权先于业务，业务只跑一次', async () => {
    const order: string[] = [];
    const handler = wrapIpcHandler(() => { order.push('business'); return 'ok'; }, {
      authorize: () => { order.push('authorize'); },
      record: () => { order.push('record'); },
    });
    expect(handler({} as any)).toBe('ok');
    expect(order).toEqual(['authorize', 'business', 'record']);
  });

  it('授权抛错时不进入业务、不记录计时', () => {
    const order: string[] = [];
    const handler = wrapIpcHandler(() => { order.push('business'); }, {
      authorize: () => { order.push('authorize'); throw new Error('非法 IPC 来源'); },
      record: () => { order.push('record'); },
    });
    expect(() => handler({} as any)).toThrow('非法 IPC 来源');
    expect(order).toEqual(['authorize']);
  });
});

describe('接入约束：index.ts 的统一入口必须走本 helper（防止 helper 变成孤岛）', () => {
  const mainIndex = fs.readFileSync(path.resolve('src/main/index.ts'), 'utf8');

  it('handle 工厂由 createIpcHandle 生成，且带前缀注册与来源校验', () => {
    expect(mainIndex).toContain("from './ipc-entry'");
    expect(mainIndex).toMatch(/createIpcHandle\(\{/);
    expect(mainIndex).toMatch(/authorize:\s*assertMainWindowSender/);
    expect(mainIndex).toMatch(/record:\s*\(name, ms\)/);
    // 计时口径不变：仍是 main-perf.log 的 `ipc <name> <ms>ms`（不带前缀）
    expect(mainIndex).toContain('perfLog(`ipc ${name} ${ms}ms`)');
  });

  it('入口内不再出现「先跑业务、再校验、又跑一遍业务」的旧形态', () => {
    // 旧实现的两处指纹：入口里重复调用 fn(...args)，以及在 fn 之后才做 sender 比对。
    const entryStart = mainIndex.indexOf('createIpcHandle({');
    expect(entryStart).toBeGreaterThan(0);
    const entry = mainIndex.slice(entryStart, mainIndex.indexOf('});', entryStart));
    expect(entry).not.toMatch(/fn\(\.\.\.args\)/);
    expect(entry).not.toMatch(/event\.sender/);
    // 全文件不得再有第二处「业务后再校验来源」的入口实现
    expect(mainIndex.match(/ipcMain\.handle\(/g) ?? []).toHaveLength(1);
    expect(mainIndex).toMatch(/register: \(channel, listener\) => ipcMain\.handle\(channel, listener\)/);
  });

  it('来源校验仍是三项同源判定：窗口存在 + sender + senderFrame', () => {
    const guard = mainIndex.slice(mainIndex.indexOf('function assertMainWindowSender'));
    const body = guard.slice(0, guard.indexOf('\n}'));
    expect(body).toContain('mainWindow');
    expect(body).toContain('event.sender !== mainWindow.webContents');
    expect(body).toContain('event.senderFrame !== mainWindow.webContents.mainFrame');
    expect(body).toContain('非法 IPC 来源');
  });
});
