import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPayload, dingtalkSign, feishuSign, ImBot, type ImConfig } from '../src/main/pi/im-bot';
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
