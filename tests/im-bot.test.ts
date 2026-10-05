import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPayload, defaultPost, dingtalkSign, feishuSign, ImBot, type ImConfig } from '../src/main/pi/im-bot';
import type { PiEvent } from '../src/shared/pi';

const config = (patch: Partial<ImConfig> = {}): ImConfig => ({
  provider: 'dingtalk',
  webhook: 'https://oapi.example/robot/send?access_token=x',
  secret: '',
  notifyCompleted: true,
  notifyError: true,
  notifyAttention: true,
  ...patch,
});

describe('wechat push payloads', () => {
  it('Server酱：SendKey 拼 URL，首行为 title、全文进 desp', () => {
    const payload = buildPayload(config({ provider: 'wechat', botToken: 'SCT123', webhook: '' }), '✅ demo 任务完成\n详情第二行');
    expect(payload.url).toBe('https://sctapi.ftqq.com/SCT123.send');
    expect(payload.body).toEqual({ title: '✅ demo 任务完成', desp: '✅ demo 任务完成\n详情第二行' });
  });

  it('Server酱：title 超 30 字截断', () => {
    const payload = buildPayload(config({ provider: 'wechat', botToken: 'K', webhook: '' }), 'x'.repeat(50));
    expect((payload.body as { title: string }).title).toHaveLength(30);
  });

  it('PushPlus：POST /send JSON（token/title/content/template）', () => {
    const payload = buildPayload(config({ provider: 'wechat', pushProvider: 'pushplus', botToken: 'PP1', webhook: '' }), 'hi');
    expect(payload.url).toBe('https://www.pushplus.plus/send');
    expect(payload.body).toEqual({ token: 'PP1', title: 'hi', content: 'hi', template: 'markdown' });
  });

  it('ImBot.send：wechat 未填 token 时抛出指引错误', async () => {
    const bot = new ImBot(path.join(os.tmpdir(), `imbot-wx-${Date.now()}.json`), async () => undefined);
    bot.save({ provider: 'wechat', botToken: '', webhook: '' });
    await expect(bot.send('x')).rejects.toThrow('Token');
  });

  it('ImBot.fireOnce：wechat 渠道无 token 时静默跳过（post 不被调用）', async () => {
    let called = 0;
    const bot = new ImBot(path.join(os.tmpdir(), `imbot-wx3-${Date.now()}.json`), async () => { called += 1; });
    bot.save({ provider: 'wechat', botToken: '', webhook: '', notifyCompleted: true, notifyError: true, notifyAttention: true });
    const mk = (status: string) => ({ type: 'run', run: { key: 'k', generation: 1, status } }) as unknown as PiEvent;
    await bot.onPiEvent(mk('running'), () => 'demo');
    await bot.onPiEvent(mk('idle'), () => 'demo');
    expect(called).toBe(0);
  });

  it('ImBot：wechat 渠道任务完成推送一次（running→idle 迁移）', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const bot = new ImBot(path.join(os.tmpdir(), `imbot-wx2-${Date.now()}.json`), async (url, body) => { calls.push({ url, body }); });
    bot.save({ provider: 'wechat', botToken: 'SCT9', webhook: '', notifyCompleted: true, notifyError: true, notifyAttention: true });
    const mk = (status: string) => ({ type: 'run', run: { key: 'k', generation: 1, status } }) as unknown as PiEvent;
    await bot.onPiEvent(mk('running'), () => 'demo'); // first sight，不推送
    await bot.onPiEvent(mk('idle'), () => 'demo');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://sctapi.ftqq.com/SCT9.send');
  });
});

describe('defaultPost 业务码检测（跨平台增强）', () => {
  // 注入 fetch 驱动 defaultPost 内部的全局 fetch
  function withFetch(payload: unknown, status = 200) {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => ({ ok: status < 400, json: async () => payload })) as typeof fetch;
    return () => { globalThis.fetch = original; };
  }

  it('feishu/dingtalk 业务失败（HTTP 200 + errcode≠0）抛出而非静默', async () => {
    const restore = withFetch({ errcode: 310000, errmsg: 'sign not match' });
    try { await expect(defaultPost('https://x', {})).rejects.toThrow('sign not match'); } finally { restore(); }
    const restore2 = withFetch({ code: 19021, msg: 'sign error' });
    try { await expect(defaultPost('https://x', {})).rejects.toThrow('sign error'); } finally { restore2(); }
  });

  it('成功形状：钉钉 errcode=0 / 飞书 code=0 / PushPlus code=200 / Telegram 无 code 字段 / 空 body 均通过', async () => {
    for (const payload of [{ errcode: 0 }, { code: 0 }, { code: 200 }, { ok: true, result: {} }, null]) {
      const restore = withFetch(payload);
      try { await expect(defaultPost('https://x', {})).resolves.toBeUndefined(); } finally { restore(); }
    }
  });

  it('HTTP 非 2xx 仍然抛出', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => ({ ok: false, status: 400, json: async () => ({}) })) as typeof fetch;
    try { await expect(defaultPost('https://x', {})).rejects.toThrow('400'); } finally { globalThis.fetch = original; }
  });
});

describe('IM webhook payloads', () => {
  it('builds plain dingtalk text payloads and appends the signature', () => {
    const plain = buildPayload(config({ secret: '' }), 'hello');
    expect(plain.url).toBe('https://oapi.example/robot/send?access_token=x');
    expect(plain.body).toEqual({ msgtype: 'text', text: { content: 'hello' } });

    const secret = 'SEC123';
    const signed = buildPayload(config({ secret }), 'hello');
    const parsed = new URL(signed.url);
    const stamp = Number(parsed.searchParams.get('timestamp'));
    const sign = parsed.searchParams.get('sign');
    expect(stamp).toBeGreaterThan(0);
    // searchParams.get returns the URL-decoded value — the raw base64 signature
    expect(sign).toBe(dingtalkSign(secret, stamp));
    expect(dingtalkSign(secret, stamp)).toBe(crypto.createHmac('sha256', secret).update(`${stamp}\n${secret}`).digest('base64'));
  });

  it('signs feishu payloads with timestamp+secret as the hmac key', () => {
    const secret = 'SECX';
    const signed = buildPayload(config({ provider: 'feishu', secret }), 'hi');
    const ts = String(signed.body.timestamp);
    expect(signed.body.sign).toBe(feishuSign(secret, Number(ts)));
    expect(signed.body.msg_type).toBe('text');
  });
});

describe('ImBot event routing', () => {
  const posted: Array<{ url: string; body: Record<string, unknown> }> = [];
  const describe = () => 'proj';
  const runEvent = (status: 'starting' | 'running' | 'idle' | 'error', generation = 'g1'): PiEvent => ({
    type: 'run',
    run: { key: 'k1', generation, cwd: '/tmp', file: '/tmp/a.jsonl', status, models: [], pending: 0 },
  });

  it('stays silent when no provider is configured', async () => {
    const bot = new ImBot(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'im-')), 'im.json'), async () => {});
    await bot.onPiEvent(runEvent('running'), describe);
    await bot.onPiEvent(runEvent('idle'), describe);
    expect(posted).toHaveLength(0);
  });

  it('notifies once per generation on completion and on errors', async () => {
    const bot = new ImBot(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'im-')), 'im.json'), async (url, body) => {
      posted.push({ url, body });
    });
    bot.save(config());
    await bot.onPiEvent(runEvent('running'), describe);
    await bot.onPiEvent(runEvent('idle'), describe);
    await bot.onPiEvent(runEvent('idle'), describe); // duplicate suppressed
    expect(posted).toHaveLength(1);
    expect(JSON.stringify(posted[0].body)).toContain('任务完成');
    await bot.onPiEvent(runEvent('error', 'g3'), describe);
    expect(posted).toHaveLength(2);
    expect(JSON.stringify(posted[1].body)).toContain('任务出错');
  });

  it('persists config across reloads', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'im-'));
    const file = path.join(dir, 'im.json');
    const bot = new ImBot(file, async () => {});
    bot.save({ provider: 'feishu', webhook: 'https://open.feishu.cn/hook/x', secret: 's' });
    const reloaded = new ImBot(file, async () => {});
    expect(reloaded.current.provider).toBe('feishu');
    expect(reloaded.current.webhook).toBe('https://open.feishu.cn/hook/x');
    expect(reloaded.current.secret).toBe('s');
  });
});
