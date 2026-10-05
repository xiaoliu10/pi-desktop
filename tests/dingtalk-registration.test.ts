import { describe, expect, it, vi } from 'vitest';
import { startDingTalkRegistration, pollDingTalkRegistration } from '../src/main/pi/dingtalk-registration';

// 钉钉应用注册 device flow（扫码一键配置）：
// init(source) → nonce → begin → {device_code, verification_uri_complete, user_code}
// → 用户钉钉扫码确认 → poll → SUCCESS{client_id, client_secret} / WAITING / FAIL / EXPIRED。

function fetchJson(payloads: Array<Record<string, unknown>>) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const impl = vi.fn(async (url: string, init?: { body: string }) => {
    calls.push({ url, body: JSON.parse(init?.body ?? '{}') });
    return { json: async () => payloads[Math.min(calls.length - 1, payloads.length - 1)] };
  });
  return { impl, calls };
}

describe('钉钉扫码一键配置：注册流', () => {
  it('start：init 用自有 source 标识，begin 成功映射会话字段', async () => {
    const { impl, calls } = fetchJson([
      { errcode: 0, nonce: 'n-123' },
      { errcode: 0, device_code: 'dc-1', verification_uri_complete: 'https://open-dev.dingtalk.com/openapp/registration/openClaw?user_code=ABCD', user_code: 'ABCD', interval: 2, expires_in: 7200 },
    ]);
    const session = await startDingTalkRegistration(impl);
    expect(calls[0].url).toContain('/app/registration/init');
    expect(calls[0].body.source).toBe('PI_DESKTOP');
    expect(calls[1].body.nonce).toBe('n-123');
    expect(session).toEqual({ url: 'https://open-dev.dingtalk.com/openapp/registration/openClaw?user_code=ABCD', deviceCode: 'dc-1', userCode: 'ABCD', intervalMs: 2000, expireInMs: 7_200_000 });
  });

  it('start：init 失败（errcode≠0）抛出平台错误信息', async () => {
    const { impl } = fetchJson([{ errcode: 90018, errmsg: 'invalid source' }]);
    await expect(startDingTalkRegistration(impl)).rejects.toThrow('invalid source');
  });

  it('poll：SUCCESS 返回凭据', async () => {
    const { impl, calls } = fetchJson([{ errcode: 0, status: 'SUCCESS', client_id: 'ding-abc', client_secret: 'sec-xyz' }]);
    const result = await pollDingTalkRegistration('dc-1', impl);
    expect(calls[0].body.device_code).toBe('dc-1');
    expect(result).toEqual({ done: true, status: 'success', clientId: 'ding-abc', clientSecret: 'sec-xyz' });
  });

  it('poll：WAITING 继续等待（不视为失败）', async () => {
    const { impl } = fetchJson([{ errcode: 0, status: 'WAITING' }]);
    const result = await pollDingTalkRegistration('dc-1', impl);
    expect(result).toEqual({ done: false, status: 'waiting' });
  });

  it('poll：FAIL/EXPIRED 终态带原因', async () => {
    const fail = fetchJson([{ errcode: 0, status: 'FAIL', fail_reason: '用户拒绝授权' }]);
    await expect(pollDingTalkRegistration('dc', fail.impl)).resolves.toMatchObject({ done: true, status: 'fail', error: '用户拒绝授权' });
    const expired = fetchJson([{ errcode: 0, status: 'EXPIRED' }]);
    await expect(pollDingTalkRegistration('dc', expired.impl)).resolves.toMatchObject({ done: true, status: 'expired', error: '授权已过期' });
  });

  it('poll：errcode≠0 视为暂时性错误，保持 waiting（外层继续轮询）', async () => {
    const { impl } = fetchJson([{ errcode: -1, errmsg: 'throttled' }]);
    const result = await pollDingTalkRegistration('dc', impl);
    expect(result).toEqual({ done: false, status: 'waiting', error: 'throttled' });
  });
});
