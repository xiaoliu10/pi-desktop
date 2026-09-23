import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalService, type PtyModule, type PtyProcess } from '../src/main/pi/terminal-service';

/** 记录调用并可控收发数据的假 pty。 */
class FakePty implements PtyProcess {
  pid = Math.floor(Math.random() * 60000) + 100;
  written: string[] = [];
  resized: Array<[number, number]> = [];
  killed = false;
  private dataCb: ((data: string) => void) | null = null;
  private exitCb: ((event: { exitCode: number }) => void) | null = null;
  constructor(public spawnArgs: { file: string; args: string[]; opts: { cwd: string; cols: number; rows: number } }) {}
  onData(cb: (data: string) => void) { this.dataCb = cb; }
  onExit(cb: (event: { exitCode: number }) => void) { this.exitCb = cb; }
  write(data: string) { this.written.push(data); }
  resize(cols: number, rows: number) { this.resized.push([cols, rows]); }
  kill() { this.killed = true; }
  emitData(data: string) { this.dataCb?.(data); }
  emitExit(exitCode = 0) { this.exitCb?.({ exitCode }); }
}

function harness() {
  const spawned: FakePty[] = [];
  const events: Array<{ type: string; id: string; data?: string; exitCode?: number }> = [];
  const scheduled: Array<() => void> = [];
  const module: PtyModule = {
    spawn: (file, args, opts) => {
      const pty = new FakePty({ file, args, opts });
      spawned.push(pty);
      return pty;
    },
  };
  const service = new TerminalService(event => events.push(event as never), () => module, fn => { scheduled.push(fn); return undefined as never; });
  return { service, spawned, events, scheduled, flush: () => { while (scheduled.length) scheduled.shift()!(); } };
}

import os from 'node:os';
const home = os.homedir();

afterEach(() => vi.restoreAllMocks());

describe('TerminalService', () => {
  it('创建会话：登录 shell、解析 cwd、返回信息', () => {
    const { service, spawned } = harness();
    const info = service.create({ cwd: '/', cols: 120, rows: 30 });
    expect(spawned).toHaveLength(1);
    expect(spawned[0].spawnArgs.args).toEqual(['--login']);
    expect(spawned[0].spawnArgs.opts.cwd).toBe('/');
    expect(spawned[0].spawnArgs.opts.cols).toBe(120);
    expect(info.shell).toMatch(/^\/(bin|usr\/bin)\//);
    expect(info.cwd).toBe('/');
    expect(info.pid).toBe(spawned[0].pid);
    expect(info.id).toMatch(/^term-/);
  });

  it('cwd 缺失或不存在时回退主目录', () => {
    const { service, spawned } = harness();
    service.create({ cwd: '/nonexistent-xyz' });
    service.create({});
    expect(spawned[0].spawnArgs.opts.cwd).toBe(home);
    expect(spawned[1].spawnArgs.opts.cwd).toBe(home);
  });

  it('输出微批：多次 onData 合并为一条事件', () => {
    const { service, spawned, events, flush } = harness();
    const info = service.create({});
    spawned[0].emitData('a');
    spawned[0].emitData('b');
    expect(events).toEqual([]);
    flush();
    expect(events).toEqual([{ type: 'terminalData', id: info.id, data: 'ab' }]);
  });

  it('write/resize 路由到对应会话', () => {
    const { service, spawned } = harness();
    const a = service.create({});
    service.create({});
    service.write(a.id, 'ls\r');
    service.resize(a.id, 100, 40);
    expect(spawned[0].written).toEqual(['ls\r']);
    expect(spawned[1].written).toEqual([]);
    expect(spawned[0].resized).toEqual([[100, 40]]);
  });

  it('exit 清理会话并广播退出码；后续写入报错', () => {
    const { service, spawned, events, flush } = harness();
    const info = service.create({});
    spawned[0].emitExit(3);
    flush();
    expect(events.at(-1)).toMatchObject({ type: 'terminalExit', id: info.id, exitCode: 3 });
    expect(service.list()).toEqual([]);
    expect(() => service.write(info.id, 'x')).toThrow('不存在');
  });

  it('kill 调用 pty.kill，兜底清理删除未退出的会话', () => {
    const { service, spawned, events, flush } = harness();
    const info = service.create({});
    service.kill(info.id);
    expect(spawned[0].killed).toBe(true);
    // 兜底定时器（测试时钟下立即执行）：shell 忽略信号时也保证会话被移除。
    flush();
    expect(service.list()).toEqual([]);
    expect(events).toContainEqual({ type: 'terminalExit', id: info.id, exitCode: -1 });
  });

  it('会话数量受上限保护', () => {
    const { service } = harness();
    const created = Array.from({ length: 12 }, () => service.create({}).id);
    expect(created).toHaveLength(12);
    expect(() => service.create({})).toThrow('上限');
  });

  it('dispose 杀掉全部会话', () => {
    const { service, spawned } = harness();
    service.create({});
    service.create({});
    service.dispose();
    expect(spawned.every(p => p.killed)).toBe(true);
    expect(service.list()).toEqual([]);
  });

  it('非法输入被拒绝', () => {
    const { service } = harness();
    service.create({});
    expect(() => service.write('missing', 'x')).toThrow('不存在');
    expect(() => service.write(service.list()[0].id, '')).toThrow('为空');
  });
});
