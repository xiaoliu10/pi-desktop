/**
 * 内置终端（复刻 ZCode 侧板终端）：主进程 node-pty 会话 + 渲染端 xterm。
 * 类型放 shared 供 main / preload / renderer 三端共用。
 */

export interface TerminalCreateInput {
  /** 会话工作目录；缺失或不存在时回退用户主目录。 */
  cwd?: string;
  cols?: number;
  rows?: number;
}

export interface TerminalInfo {
  id: string;
  shell: string;
  cwd: string;
  pid: number;
}

export interface TerminalDataEvent {
  id: string;
  data: string;
}

export interface TerminalExitEvent {
  id: string;
  exitCode: number;
}
