import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { PiRpcClient } from '../src/main/pi/rpc-client';

const clients: PiRpcClient[] = [];
const client = () => { const c = new PiRpcClient(process.execPath, [path.resolve('tests/fixtures/fake-pi-flood.mjs')], process.cwd(), process.env); clients.push(c); return c; };
afterEach(() => clients.splice(0).forEach(c => c.close()));

describe('RPC 单帧上限（按单条 JSONL 检查，不再按 chunk 聚合误杀）', () => {
  it('单个超限完整响应：仅该请求被拒绝，同 chunk 的正常帧恢复处理，进程存活', async () => {
    const c = client();
    const diagnostics: string[] = []; c.on('diagnostic', m => diagnostics.push(String(m)));
    const held = c.request('hold'); // 响应被 fixture 扣住，与超限帧同一次 write 发出
    const flooded = c.request('flood-then-good');
    await expect(flooded).rejects.toThrow(/16 MiB/);
    await expect(held).resolves.toBe('held');
    expect(diagnostics.some(m => m.includes('16 MiB'))).toBe(true);
    await expect(c.request('get_state')).resolves.toEqual({ alive: true }); // 后续正常帧可处理
  });

  it('超限帧体含多字节字符且被 chunk 边界劈开：CRLF 帧尾排空后，合法响应照常 resolve，进程存活', async () => {
    const c = client();
    const held = c.request('hold'); // 响应被 fixture 扣住，紧接在超限帧的 CRLF 帧尾之后发出
    const flooded = c.request('flood-crlf-split');
    await expect(flooded).rejects.toThrow(/16 MiB/);
    // 帧体全部由多字节字符组成（64KB 级 chunk 边界几乎必然劈开字符），且 fixture 在
    // '中' 的 3 字节序列内部显式切割两次 write：合法响应能 resolve 即证明跨 chunk 的
    // UTF-8 拼回与 CR 剥离均未被破坏。
    await expect(held).resolves.toBe('held-crlf');
    await expect(c.request('get_state')).resolves.toEqual({ alive: true });
  });

  it('多个小帧合计超 16MiB：全部正常处理，不杀进程', async () => {
    const c = client();
    const held = c.request('hold');
    const burst = c.request('burst', {}, 400); // burst 自身无响应：随超时收尾，pad 帧不得误伤
    await expect(burst).rejects.toThrow('burst 超时');
    await expect(held).resolves.toBe('held');
    await expect(c.request('get_state')).resolves.toEqual({ alive: true });
  });

  it('换行迟迟未到的超限半帧：按前缀识别归属并立即拒绝，排空后正常帧恢复', async () => {
    const c = client();
    const flooded = c.request('flood-partial');
    await expect(flooded).rejects.toThrow(/16 MiB/); // 半帧超限即刻拒绝（不等到请求超时）
    const tail = c.request('flood-partial-tail');
    await expect(tail).resolves.toBe('tail-done'); // 排空到换行后恢复正常处理
    await expect(c.request('get_state')).resolves.toEqual({ alive: true });
  });

  it('无法识别归属的超限帧：不做错误关联（等待自身超时），进程存活', async () => {
    const c = client();
    const diagnostics: string[] = []; c.on('diagnostic', m => diagnostics.push(String(m)));
    const anon = c.request('flood-anon', {}, 400);
    await expect(anon).rejects.toThrow('flood-anon 超时'); // 不是被错误 resolve/reject
    // 满载下 17MiB 帧可能晚于超时才流完：等 diagnostic 到达而不是立即断言（放宽到 5s，防 CI 慢机误报）
    await vi.waitFor(() => expect(diagnostics.some(m => m.includes('未能识别归属请求'))).toBe(true), { timeout: 5000 });
    await expect(c.request('get_state')).resolves.toEqual({ alive: true });
  });

  it('归因区分：本机主动 close 的 SIGTERM 不推测外部 kill；外部 SIGKILL 保留推测', async () => {
    const mine = client();
    mine.close();
    await vi.waitFor(() => expect(mine.exitDetail()).toContain('SIGTERM'));
    expect(mine.closedLocally()).toBe(true);
    expect(mine.exitDetail()).not.toMatch(/内存压力|外部/); // 自己发的 SIGTERM 不是系统/OOM 证据
    expect(mine.failureReason()).toBe('pi 连接已关闭');

    const external = client();
    const gone = external.request('never').catch(e => e);
    (external as unknown as { child: { kill(s: string): void } }).child.kill('SIGKILL'); // 非 close() 发出
    expect(String(await gone)).toMatch(/退出/);
    await vi.waitFor(() => expect(external.exitDetail()).toContain('SIGKILL'));
    expect(external.closedLocally()).toBe(false);
    expect(external.exitDetail()).toMatch(/内存压力|外部/);
  });
});
