import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import desktopPolicy from '../extensions/desktop-policy/index.mjs';

// desktop-policy 权限审批五选项（ZCode 同款）：允许/始终允许本项目/完全访问/拒绝/自定义指引。
function setup({ selectImpl, modeFile } = {}) {
  const audit = [];
  const handlers = {};
  const selectCalls = [];
  const pi = {
    on: (event, fn) => { handlers[event] = fn; },
    getAllTools: () => [
      { name: 'write', sourceInfo: { source: 'builtin' } },
      { name: 'edit', sourceInfo: { source: 'builtin' } },
      { name: 'bash', sourceInfo: { source: 'builtin' } },
      { name: 'read', sourceInfo: { source: 'builtin' } },
    ],
    getActiveTools: () => ['read', 'write', 'edit', 'bash'],
    setActiveTools: () => {},
    registerTool: () => {},
    appendEntry: (_type, data) => audit.push(data),
    ui: { setStatus: () => {} },
  };
  process.env.PI_DESKTOP_PERMISSION = 'ask';
  if (modeFile) process.env.PI_DESKTOP_MODE_FILE = modeFile;
  else delete process.env.PI_DESKTOP_MODE_FILE;
  desktopPolicy(pi);
  const ctx = {
    cwd: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-policy-')), 'proj'),
    signal: undefined,
    ui: {
      setStatus: () => {},
      select: async (title, options) => {
        selectCalls.push({ title, options });
        return selectImpl(title, options);
      },
    },
  };
  fs.mkdirSync(ctx.cwd, { recursive: true });
  return { audit, handlers, selectCalls, ctx };
}

const writeEvent = (file, content) => ({ toolName: 'write', toolCallId: 'c1', input: { path: file, content } });

describe('desktop-policy 权限审批五选项', () => {
  it('允许 → 放行并审计；title 内编码 meta 与 diff 文档', async () => {
    const { audit, handlers, selectCalls, ctx } = setup({ selectImpl: () => '允许' });
    const result = await handlers.tool_call(writeEvent('a.md', '# hello\n'.repeat(5)), ctx);
    expect(result).toBeUndefined();
    expect(selectCalls).toHaveLength(1);
    const { title, options } = selectCalls[0];
    expect(title.split('\n')[0]).toBe('Desktop 审批 · write');
    expect(title).toContain('[pi-desktop-meta]');
    expect(JSON.parse(title.split('[pi-desktop-meta]')[1].split('\n')[0]).name).toBe('a.md');
    expect(title).toContain('[pi-desktop-message]');
    expect(options).toEqual(['允许', '始终允许本项目', '完全访问', '拒绝', '告诉模型接下来应该怎么做']);
    expect(audit.some(a => a.type === 'tool' && a.decision === 'allow')).toBe(true);
  });

  it('拒绝 → block，原因回传模型', async () => {
    const { audit, handlers, ctx } = setup({ selectImpl: () => '拒绝' });
    const result = await handlers.tool_call(writeEvent('a.md', 'x'), ctx);
    expect(result).toEqual({ block: true, reason: '用户拒绝本次操作' });
    expect(audit.some(a => a.decision === 'deny')).toBe(true);
  });

  it('自定义指引文字 → 作为 block 原因回传（select 响应任意值直传）', async () => {
    const { handlers, ctx } = setup({ selectImpl: () => '改用增量写入，别全量覆盖' });
    const result = await handlers.tool_call(writeEvent('a.md', 'x'), ctx);
    expect(result).toEqual({ block: true, reason: '改用增量写入，别全量覆盖' });
  });

  it('始终允许本项目 → 会话内相同目标不再询问', async () => {
    const { handlers, selectCalls, ctx } = setup({ selectImpl: () => '始终允许本项目' });
    const first = await handlers.tool_call(writeEvent('a.md', 'x'), ctx);
    expect(first).toBeUndefined();
    const second = await handlers.tool_call(writeEvent('a.md', 'y'), ctx);
    expect(second).toBeUndefined();
    expect(selectCalls).toHaveLength(1); // 第二次不再弹审批
    const other = await handlers.tool_call(writeEvent('b.md', 'z'), ctx);
    expect(other).toBeUndefined();
    expect(selectCalls).toHaveLength(2); // 不同目标照常询问
  });

  it('完全访问 → 切换模式，后续不再询问，mode 文件同步写入', async () => {
    const modeFile = path.join(os.tmpdir(), `pi-mode-${Date.now()}`);
    const { handlers, selectCalls, ctx } = setup({ selectImpl: () => '完全访问', modeFile });
    const first = await handlers.tool_call(writeEvent('a.md', 'x'), ctx);
    expect(first).toBeUndefined();
    expect(fs.readFileSync(modeFile, 'utf8').trim()).toBe('fullAccess');
    await handlers.tool_call(writeEvent('b.md', 'y'), ctx);
    await handlers.tool_call({ toolName: 'bash', toolCallId: 'c3', input: { command: 'rm -rf /tmp/x' } }, ctx);
    expect(selectCalls).toHaveLength(1); // 全部不再询问
    fs.unlinkSync(modeFile);
    delete process.env.PI_DESKTOP_MODE_FILE;
  });

  it('取消（undefined）→ 按拒绝处理', async () => {
    const { handlers, ctx } = setup({ selectImpl: () => undefined });
    const result = await handlers.tool_call(writeEvent('a.md', 'x'), ctx);
    expect(result).toEqual({ block: true, reason: '用户拒绝或运行已取消' });
  });
});
