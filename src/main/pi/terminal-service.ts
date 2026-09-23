import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { TerminalCreateInput, TerminalDataEvent, TerminalExitEvent, TerminalInfo } from '../../shared/terminal';

/**
 * 内置终端会话服务：node-pty 会话表 + 事件广播。
 *
 * pty 模块懒加载（Electron ABI 预编译产物），并支持注入以便单测在纯 Node
 * 环境运行；输出按 ~16ms 微批，避免高频输出（如 cat 大文件）打爆 IPC。
 */

export interface PtyProcess {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(callback: (data: string) => void): void;
  onExit(callback: (event: { exitCode: number; signal?: number }) => void): void;
  readonly pid: number;
}

export interface PtyModule {
  spawn(file: string, args: string[], options: {
    name: string;
    cols: number;
    rows: number;
    cwd: string;
    env: Record<string, string | undefined>;
  }): PtyProcess;
}

export type TerminalServiceEvent =
  | { type: 'terminalData'; id: string; data: string }
  | { type: 'terminalExit'; id: string; exitCode: number };

const MAX_TERMINALS = 12;
const FLUSH_INTERVAL_MS = 16;

function loadNodePty(): PtyModule {
  return createRequire(__filename)('node-pty') as PtyModule;
}

export class TerminalService {
  private readonly sessions = new Map<string, { pty: PtyProcess; shell: string; cwd: string; buffer: string[]; timer: ReturnType<typeof setTimeout> | null }>();

  constructor(
    private readonly emit: (event: TerminalServiceEvent) => void,
    private readonly loadPty: () => PtyModule = loadNodePty,
    /** 时钟注入只为了测试批处理不等待真实时间；返回值仅为可清零的 timer 便攜。 */
    private readonly schedule: (fn: () => void, ms: number) => unknown = (fn, ms) => setTimeout(fn, ms),
  ) {}

  create(input: TerminalCreateInput): TerminalInfo {
    if (this.sessions.size >= MAX_TERMINALS) throw new Error(`终端数量已达上限（${MAX_TERMINALS}），请先关闭一些终端。`);
    const shell = this.resolveShell();
    const cwd = this.resolveCwd(input.cwd);
    const pty = this.loadPty().spawn(shell, ['--login'], {
      name: 'xterm-256color',
      cols: clampDims(input.cols, 80),
      rows: clampDims(input.rows, 24),
      cwd,
      env: this.childEnv(cwd),
    });
    const id = `term-${randomUUID().slice(0, 8)}`;
    const session = { pty, shell, cwd, buffer: [] as string[], timer: null as ReturnType<typeof setTimeout> | null };
    this.sessions.set(id, session);
    pty.onData(data => {
      session.buffer.push(data);
      if (session.timer === null) session.timer = this.schedule(() => this.flush(id), FLUSH_INTERVAL_MS) as ReturnType<typeof setTimeout>;
    });
    pty.onExit(({ exitCode }) => {
      this.flush(id);
      this.sessions.delete(id);
      this.emit({ type: 'terminalExit', id, exitCode });
    });
    return { id, shell, cwd, pid: pty.pid };
  }

  write(id: string, data: string): void {
    if (typeof data !== 'string' || data.length === 0 || data.length > 1_000_000) throw new Error('终端输入为空或超过 1MB');
    this.get(id).pty.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    this.get(id).pty.resize(clampDims(cols, 80), clampDims(rows, 24));
  }

  kill(id: string): void {
    this.get(id).pty.kill();
    // 进程退出是异步的；exit 事件负责清理与广播。个别 shell 忽略信号时兜底清理。
    this.schedule(() => {
      if (this.sessions.has(id)) {
        this.sessions.delete(id);
        this.emit({ type: 'terminalExit', id, exitCode: -1 });
      }
    }, 2_000);
  }

  list(): TerminalInfo[] {
    return [...this.sessions.entries()].map(([id, s]) => ({ id, shell: s.shell, cwd: s.cwd, pid: s.pty.pid }));
  }

  /** 退出/关窗时杀掉全部会话。 */
  dispose(): void {
    for (const [, session] of this.sessions) {
      try { session.pty.kill(); } catch { /* 进程可能已退出 */ }
    }
    this.sessions.clear();
  }

  private get(id: string) {
    const session = this.sessions.get(id);
    if (!session) throw new Error('终端会话不存在或已退出');
    return session;
  }

  private flush(id: string) {
    const session = this.sessions.get(id);
    if (!session) return;
    session.timer = null;
    if (session.buffer.length === 0) return;
    const data = session.buffer.join('');
    session.buffer = [];
    this.emit({ type: 'terminalData', id, data });
  }

  private resolveShell(): string {
    const candidate = process.env.SHELL?.trim();
    if (candidate && fs.existsSync(candidate)) return candidate;
    for (const fallback of ['/bin/zsh', '/bin/bash']) {
      if (fs.existsSync(fallback)) return fallback;
    }
    return '/bin/sh';
  }

  private resolveCwd(cwd: string | undefined): string {
    if (cwd && path.isAbsolute(cwd) && fs.existsSync(cwd)) return cwd;
    return os.homedir();
  }

  private childEnv(cwd: string): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    // GUI 应用不继承 shell 的 PATH，补上常见的包管理器路径，保证 node/git 等可用。
    env.PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin', env.PATH ?? ''].join(path.delimiter);
    env.PWD = cwd;
    return env;
  }
}

function clampDims(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) >= 2 && (value as number) <= 500 ? Math.floor(value as number) : fallback;
}
