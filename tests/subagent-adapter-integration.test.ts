import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// 真停滞集成测试：官方扩展的子 pi 进程被孙进程占住 stdio，close 永不触发 →
// tool.execute 永不 resolve。看门狗必须在宽限期后从包装层抛出友好错误，
// 让 pi 正常发出 tool_execution_end(isError)。
// 这里把 index.mjs 顶层 import 的官方扩展替换成永不 settle 的 mock tool，
// 驱动真实包装逻辑（onUpdate 包装 + race + abort + settled 闸）。
vi.mock('/Users/jason/projects/opensource/pi-desktop/resources/pi-runtime/node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/index.ts', () => ({
  default: (pi) => pi.registerTool({
    name: 'subagent',
    // 真停滞：永不 resolve（模拟 close 被孙进程挂住）。
    _never: new Promise(() => {}),
    async execute(_toolCallId, _params, _signal, onUpdate, _ctx) {
      // 真停滞：永不 resolve（模拟 close 被孙进程挂住）。
      // 把包装后的 onUpdate 暴露给测试，由测试驱动注入快照。
      (globalThis).__subagentOnUpdate = onUpdate;
      return new Promise(() => {});
    },
  }),
}));


// import 必须在 vi.mock 之后（hoisting 由 vitest 处理）。
const adapterModule = await import('../extensions/desktop-subagent/index.mjs');
const adapter = adapterModule.default;

describe('desktop-subagent 包装层真停滞集成（占住不返回）', () => {
  const origModeFile = process.env.PI_DESKTOP_MODE_FILE;
  const origPerm = process.env.PI_DESKTOP_PERMISSION;
  beforeEach(() => {
    process.env.PI_DESKTOP_PERMISSION = 'fullAccess';
    delete process.env.PI_DESKTOP_MODE_FILE;
    vi.useFakeTimers();
  });
  afterEach(() => {
    if (origModeFile) process.env.PI_DESKTOP_MODE_FILE = origModeFile; else delete process.env.PI_DESKTOP_MODE_FILE;
    if (origPerm) process.env.PI_DESKTOP_PERMISSION = origPerm; else delete process.env.PI_DESKTOP_PERMISSION;
    vi.useRealTimers();
  });

  it('execute 占住不返回 + 失败终态快照 → 宽限期后抛出友好错误并掐断透传', async () => {
    const captured = {};
    const pi = { registerTool(tool) { captured.tool = tool; } };
    adapter(pi);
    expect(captured.tool).toBeTruthy();

    // onUpdate spy：包一层记录 original 调用次数（验证触发后透传被掐断）
    let originalCalls = 0;
    const spyOnOriginal = (u) => { originalCalls += 1; };
    // execute 收到的是包装后的 onUpdate；mock tool 把它暴露到 globalThis
    const pending = captured.tool.execute('call_x', { agent: 'a', task: 't' }, undefined, spyOnOriginal, { cwd: '/tmp' });
    const wrappedOnUpdate = (globalThis).__subagentOnUpdate;
    expect(wrappedOnUpdate, 'mock tool 应暴露 onUpdate').toBeTruthy();
    // 推一次失败终态快照（emitUpdate 语义）→ 透传给 original（originalCalls=1）+ 布防 timer
    wrappedOnUpdate({ details: { results: [{ agent: 'a', stopReason: 'error', stderr: 'boom: 模型失败' }] } });
    expect(originalCalls, '首次 update 应透传给 original').toBe(1);

    let result;
    pending.catch(e => { result = e; });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(result, '宽限期内不得提前抛出').toBeUndefined();
    await vi.advanceTimersByTimeAsync(2);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain('子代理已失败但未正常返回');
    expect((result as Error).message).toContain('a: boom: 模型失败');
    // 触发后掐断透传：再推 update 不应调 original
    const callsBefore = originalCalls;
    wrappedOnUpdate({ details: { results: [{ agent: 'a', stopReason: 'error', stderr: 'late' }] } });
    expect(originalCalls, '触发后透传应被掐断').toBe(callsBefore);
  });

  it('健康并行（toolUse 运行中）永不布防，execute 占住也不抛', async () => {
    const captured = {};
    const pi = { registerTool(tool) { captured.tool = tool; } };
    adapter(pi);
    const pending = captured.tool.execute('call_y', {}, undefined, () => {}, { cwd: '/tmp' });
    const wrappedOnUpdate = (globalThis).__subagentOnUpdate;
    wrappedOnUpdate({ details: { results: [{ agent: 'a', stopReason: 'error', stderr: 'x' }, { agent: 'b', stopReason: 'toolUse' }] } });
    let threw = false;
    pending.catch(() => { threw = true; });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(threw, 'sibling 还在运行（toolUse 非终态），不得误杀').toBe(false);
  });
});
