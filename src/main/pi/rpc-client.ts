import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Desktop 诊断日志目录：stderr 与 RPC 诊断共用的落盘位置。 */
export const piLogDir = path.join(os.homedir(), 'Library', 'Logs', 'PI Desktop');
/** pi 子进程 stderr 落盘位置：启动期静默死亡（扩展加载崩溃）时 stderr 常是唯一证据，
 *  而内存 stderrTail 只在 close 后的红条可见——先落盘供事后取证（log show 之前）。 */
const piStderrLog = path.join(piLogDir, 'pi-stderr.log');
/** RPC 单帧（JSONL 一行）字节上限。帧限是安全边界：超限帧按单帧识别与丢弃，
 *  绝不无界拼接内存，也绝不因此杀掉整个 pi 进程——后续正常帧继续处理。 */
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
/** 从超限帧前缀识别归属请求的扫描窗口：official rpc-mode 响应帧首字段即 id（uuid），
 *  command 紧随其后，1KB 足够，且避免触碰帧内容（不解析、不构建大对象）。 */
const FRAME_ID_PREFIX_SCAN = 1024;
export class PiRpcClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<string, { resolve: (x: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private stopped = false;
  private closedByUs = false;
  private failureMessage = '';
  private diagnostic = '';
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  private stderrTail = '';
  private stderrLogged = false;
  constructor(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
    super();
    this.child = spawn(command, args, { cwd, env, stdio: 'pipe', shell: false, detached: process.platform !== 'win32' });
    const decoder = new StringDecoder('utf8'); let buffer = '';
    // 超限半帧的排空模式：丢弃字节直到该帧的换行符为止，期间不解析不拼接。
    let draining = false;
    /** 单帧超限（如 get_messages 把全量历史含图片 base64 序列化成一帧）：只丢弃该帧并
     *  拒绝对应请求。按帧前缀识别 id 防止错误关联；识别不了就不动其他 pending
     *  （不错误 resolve/reject，该请求按自身超时收尾）。 */
    const dropOversized = (prefix: string) => {
      const id = (prefix.match(/"id"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/) ?? [])[1];
      const command = (prefix.match(/"command"\s*:\s*"([A-Za-z0-9_.-]+)"/) ?? [])[1];
      const message = `pi 响应单帧超过 16 MiB 上限已丢弃${command ? `（${command}）` : ''}；该请求被拒绝，会话继续。`;
      const pending = id ? this.pending.get(id) : undefined;
      if (pending) { clearTimeout(pending.timer); this.pending.delete(id); pending.reject(new Error(message)); }
      this.emit('diagnostic', pending ? message : `${message}（未能识别归属请求，不做错误关联）`);
    };
    this.child.stdout.on('data', chunk => {
      buffer += decoder.write(chunk);
      if (draining) {
        const end = buffer.indexOf('\n');
        if (end < 0) { buffer = ''; return; } // 仍在超限帧体内：全部丢弃
        buffer = buffer.slice(end + 1); draining = false; // 排空到换行，恢复正常处理
      }
      let at: number;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at).replace(/\r$/, ''); buffer = buffer.slice(at + 1);
        if (!line.trim()) continue;
        // 按单条 JSONL 帧检查上限（而非 chunk 内聚合累计）：多个小帧合计超限是正常吞吐
        if (Buffer.byteLength(line) > MAX_FRAME_BYTES) { dropOversized(line.slice(0, FRAME_ID_PREFIX_SCAN)); continue; }
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
      // 换行迟迟未到的半帧同样受上限约束：超限即刻进入排空，防止对无界帧持续拼接内存
      if (!draining && Buffer.byteLength(buffer) > MAX_FRAME_BYTES) { dropOversized(buffer.slice(0, FRAME_ID_PREFIX_SCAN)); buffer = ''; draining = true; }
    });
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.diagnostic = 'pi 进程有 stderr 诊断输出（为避免泄露配置，未转发原文）。';
      // 保留末尾若干行：pi 启动失败（如扩展冲突）的第一现场就在这里，是用户唯一能自助的线索。
      this.stderrTail = (this.stderrTail + String(chunk)).slice(-4000);
      // 落盘（每条会话一次，带 pid 与时间戳前缀）：静默死亡场景的第一现场。
      try {
        fs.mkdirSync(path.dirname(piStderrLog), { recursive: true });
        if (!this.stderrLogged) { this.stderrLogged = true; fs.appendFileSync(piStderrLog, `\n--- pi pid=${this.child.pid} ${new Date().toISOString()} ---\n`); }
        fs.appendFileSync(piStderrLog, chunk);
      } catch { /* 落盘失败不影响主流程 */ }
    });
    this.child.on('error', err => this.fail(err));
    this.child.on('exit', (code, signal) => { this.exitInfo = { code, signal }; this.fail(new Error(`pi 已退出 (${signal || code})。${this.diagnostic}`)); this.emit('closed'); });
    this.child.stdin.on('error', err => this.fail(new Error(`pi 管道已断开（${err.message}），进程可能已退出`)));
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
  /** 首个因果故障（不含 stderr 尾巴）；空串 = 没有已知因果故障（如外部 kill）。
   *  后续 generic 关闭/退出错误不覆盖它，红条归因以此为优先。 */
  failureReason(): string { return this.failureMessage; }
  /** Desktop 是否主动断开：close() 自身也发 SIGTERM，exit 事件无法区分归属，
   *  红条归因必须用此标记，不能把本机主动断开说成系统/OOM。 */
  closedLocally(): boolean { return this.closedByUs; }
  /** How the process ended — signal (external kill) vs exit code (self-exit).
   *  「外部终止/内存压力」的推测只在本机未主动断开时成立：本程序 close() 发的就是 SIGTERM。 */
  exitDetail(): string {
    if (!this.exitInfo) return '';
    const how = this.exitInfo.signal ? `信号 ${this.exitInfo.signal}` : `退出码 ${this.exitInfo.code ?? '未知'}`;
    const externalKill = this.exitInfo.signal && !this.closedByUs && !this.stderrTail.trim()
      ? '（非 Desktop 主动断开且无任何报错输出，可能被外部工具终止或系统内存压力 kill）' : '';
    return how + externalKill;
  }
  private fail(error: Error) {
    this.stopped = true;
    if (!this.failureMessage) this.failureMessage = error.message; // 首个因果故障优先保留，不被 generic 关闭/退出覆盖
    const detail = this.stderrDetail();
    if (detail) error.message = `${error.message}\npi stderr：${detail}`;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); } this.pending.clear();
  }
  close() {
    this.closedByUs = true; // 之后的 SIGTERM 是自己发的：exit 归因不得说成系统/外部 kill
    this.fail(new Error('pi 连接已关闭'));
    const kill = (signal: NodeJS.Signals) => { if (this.child.exitCode !== null || this.child.signalCode !== null) return; try { if (this.child.pid && process.platform !== 'win32') process.kill(-this.child.pid, signal); else this.child.kill(signal); } catch { /* already exited */ } };
    kill('SIGTERM');
    const timer = setTimeout(() => kill('SIGKILL'), 1500); timer.unref();
    this.child.once('exit', () => clearTimeout(timer));
  }
}
