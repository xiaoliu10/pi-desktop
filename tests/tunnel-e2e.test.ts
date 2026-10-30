import { describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { TunnelClient } from '../src/main/pi/tunnel-client';

/**
 * 真实互通：本机 Go relay 进程 + 桌面 tunnel-client + 假 terminal WS 客户端。
 * 覆盖完整链路：注册 → token → WS upgrade → 配对 → terminal 发 HTTP 请求帧 →
 * client 调本地服务 → 回包给 terminal。
 */
const GO = '/usr/local/go/bin/go';
const relayDir = '/Users/jason/projects/opensource/pi-tunnel-relay';
const KEY = 'e2e-test-key';

function buildRelay(): string {
  const r = spawnSync(GO, ['build', '-o', '/tmp/pi-tunnel-relay-e2e', '.'], { cwd: relayDir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`go build failed: ${r.stdout}${r.stderr}`);
  return '/tmp/pi-tunnel-relay-e2e';
}

function wsUrlOf(srv: string, token: string, sid: string, role = 'terminal') {
  return `ws://${srv.replace(/^https?:\/\//, '10.0.0.1'.length ? '127.0.0.1' : '')}`.replace(/^ws:\/\/[^/]+/, `ws://127.0.0.1`) + `/api/v1/remote/ws2?role=${role}&token=${token}` + (role === 'device' ? `&sid=${sid}` : '');
}

describe('tunnel-client ↔ go relay end-to-end', () => {
  it('pairs with a real relay and serves a terminal HTTP request against the local server', async () => {
    const bin = buildRelay();
    const port = 18999;
    const relay = spawn(bin, ['-addr', `127.0.0.1:${port}`, '-key', KEY], { stdio: ['ignore', 'pipe', 'pipe'] });
    const relayErr: string[] = [];
    relay.stderr.on('data', d => relayErr.push(String(d)));
    try {
      // 等 relay 起来
      await new Promise((r) => setTimeout(r, 800));

      const localHits: Array<{ path: string; auth: string | undefined }> = [];
      const localFetch = (async (input: any, init?: any) => {
        const url = String(input);
        if (url.includes('/api/state')) {
          localHits.push({ path: '/api/state', auth: init?.headers?.authorization });
          return new Response(JSON.stringify({ sessions: [], runs: [] }), { status: 200 });
        }
        return new Response('{}', { status: 404 });
      }) as unknown as typeof fetch;

      const relayFetch = (async (input: any, init?: any) => {
        const url = String(input).replace('https://relay.local', `http://127.0.0.1:${port}`);
        return fetch(url, init);
      }) as unknown as typeof fetch;

      const client = new TunnelClient({
        relayUrl: 'https://relay.local', // 被 relayFetch 重写，不走真网络
        key: KEY,
        deviceMid: 'e2e-mbp',
        localBase: () => 'http://local.invalid',
        localToken: () => 'local-secret',
        relayFetch,
        fetchImpl: localFetch,
        wsFactory: (url) => {
          // relayFetch 只重写 https://relay.local 的 HTTP；WS 直接连真 relay
          const real = url.replace('wss://relay.local', `ws://127.0.0.1:${port}`);
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { WebSocket } = require('ws') as typeof import('ws');
          return new WebSocket(real);
        },
      });

      const states: string[] = [];
      client.on('state', s => states.push(s));
      await client.start();
      // 先等 waiting（device 已上线），terminal 上线后才会变 paired
      await new Promise<boolean>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('never reached waiting')), 8000);
        client.on('state', s => { if (s === 'waiting' || s === 'paired') { clearTimeout(t); resolve(true); } });
      });

      // 假 terminal：拿 token → WS 上线（这一步触发 device 侧变 paired）
      const base = `http://127.0.0.1:${port}`;
      const tok = await (await fetch(`${base}/api/v1/remote/token`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-relay-key': KEY },
        body: JSON.stringify({ role: 'terminal' }),
      })).json() as any;
      expect(tok.code).toBe(0);

      const { WebSocket } = await import('ws');
      const term = new WebSocket(`ws://127.0.0.1:${port}/api/v1/remote/ws2?role=terminal&token=${tok.data.token}`);
      await new Promise(r => term.once('open', r));

      // terminal 上线 → relay 通知 device（pair_status_ack matched）→ client 变 paired
      const paired = await new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), 8000);
        client.on('state', s => { if (s === 'paired') { clearTimeout(t); resolve(true); } });
      });
      expect(paired).toBe(true);
      expect(client.state()).toBe('paired');
      term.send(JSON.stringify({ type: 'data', payload: { id: 'r1', method: 'GET', path: '/api/state' } }));

      const reply = await new Promise<string>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('no reply from device')), 8000);
        term.on('message', d => {
          const s = String(d);
          if (s.includes('"r1"')) { clearTimeout(t); resolve(s); }
        });
      });
      const frame = JSON.parse(reply) as any;
      expect(frame.type).toBe('data');
      expect(frame.payload.id).toBe('r1');
      expect(frame.payload.status).toBe(200);
      expect(frame.payload.body.sessions).toEqual([]);

      // 断言 client 调本地服务时带了 Authorization
      expect(localHits.length).toBe(1);
      expect(localHits[0].auth).toBe('Bearer local-secret');

      client.stop();
      term.close();
    } finally {
      relay.kill();
    }
  }, 30_000);
});
