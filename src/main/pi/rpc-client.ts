import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { randomUUID } from 'node:crypto';
export class PiRpcClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<string, { resolve: (x: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private stopped = false;
  private diagnostic = '';
  private stderrTail = '';
  constructor(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
    super();
    this.child = spawn(command, args, { cwd, env, stdio: 'pipe', shell: false, detached: process.platform !== 'win32' });
    const decoder = new StringDecoder('utf8'); let buffer = '';
    this.child.stdout.on('data', chunk => {
      buffer += decoder.write(chunk);
      if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) { this.fail(new Error('pi RPC 帧超过 16 MiB')); this.close(); return; }
      let at: number;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at).replace(/\r$/, ''); buffer = buffer.slice(at + 1);
        if (!line.trim()) continue;
        let event: any;
        try { event = JSON.parse(line); } catch { this.emit('diagnostic', 'pi stdout 含非 JSONL 输出，已忽略。'); continue; }
        if (!event || typeof event !== 'object') continue;
        if (event.type === 'response') {
          const request = this.pending.get(event.id);
          if (!request) continue;
          clearTimeout(request.timer); this.pending.delete(event.id);
          if (event.success) request.resolve(event.data);
          else request.reject(new Error(String(event.error || 'pi 拒绝请求')));
        } else this.emit('event', event);
      }
    });
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.diagnostic = 'pi 进程有 stderr 诊断输出（为避免泄露配置，未转发原文）。';
      // 保留末尾若干行：pi 启动失败（如扩展冲突）的第一现场就在这里，是用户唯一能自助的线索。
      this.stderrTail = (this.stderrTail + String(chunk)).slice(-4000);
    });
    this.child.on('error', err => this.fail(err));
    this.child.on('exit', (code, signal) => { this.fail(new Error(`pi 已退出 (${signal || code})。${this.diagnostic}`)); this.emit('closed'); });
    this.child.stdin.on('error', err => this.fail(err));
  }
  request(type: string, data: Record<string, unknown> = {}, timeout = 30_000): Promise<any> {
    if (this.stopped) return Promise.reject(new Error('pi 进程未连接'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${type} 超时；未自动重试，执行状态可能未知。`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ ...data, type, id });
    });
  }
  send(value: Record<string, unknown>) {
    if (this.stopped) throw new Error('pi 进程未连接');
    this.child.stdin.write(JSON.stringify(value) + '\n');
  }
  /** Startup/crash stderr tail (trimmed) — safe to show: pi 的致命错误行不携带密钥，且只在本机 UI 展示。 */
  stderrDetail(): string {
    return this.stderrTail.split('\n').map(l => l.trim()).filter(Boolean).slice(-3).join('\n').slice(0, 400);
  }
  private fail(error: Error) {
    this.stopped = true;
    const detail = this.stderrDetail();
    if (detail) error.message = `${error.message}\npi stderr：${detail}`;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); } this.pending.clear();
  }
  close() {
    this.fail(new Error('pi 连接已关闭'));
    const kill = (signal: NodeJS.Signals) => { if (this.child.exitCode !== null || this.child.signalCode !== null) return; try { if (this.child.pid && process.platform !== 'win32') process.kill(-this.child.pid, signal); else this.child.kill(signal); } catch { /* already exited */ } };
    kill('SIGTERM');
    const timer = setTimeout(() => kill('SIGKILL'), 1500); timer.unref();
    this.child.once('exit', () => clearTimeout(timer));
  }
}
