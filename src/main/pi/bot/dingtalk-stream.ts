/**
 * DingTalk Stream-mode transport: an outbound WebSocket long connection that
 * receives bot messages without any public endpoint. Protocol (open-dingtalk
 * stream SDK): open a connection ticket from the gateway, connect to the
 * returned WSS endpoint, reply ack per message, keep-alive with ping frames.
 */

import { imLog } from './im-log';
import crypto from 'node:crypto';
import WebSocket from 'ws';
import type { ImTransport, IncomingMessage, TransportContext } from './transport';

const TOPIC_BOT_MESSAGE = '/v1.0/im/bot/messages/get';

export interface DingTalkCredentials {
  appKey: string;
  appSecret: string;
}

/** POST to the gateway for a stream endpoint ticket. Injectable for tests. */
export async function openConnection(
  gatewayUrl: string,
  creds: DingTalkCredentials,
  postJson: (url: string, body: unknown) => Promise<any>,
): Promise<{ endpoint: string; ticket: string }> {
  const body = {
    clientId: creds.appKey,
    clientSecret: creds.appSecret,
    subscriptions: [{ type: 'CALLBACK', topic: TOPIC_BOT_MESSAGE }],
    ua: 'pi-desktop',
    localIp: '1.1.1.1',
    localPort: 80,
  };
  const res = await postJson(gatewayUrl, body);
  if (!res?.endpoint) throw new Error(`钉钉网关返回异常：${JSON.stringify(res).slice(0, 200)}`);
  return { endpoint: res.endpoint, ticket: res.ticket ?? '' };
}

/** Decode an incoming stream frame into a bot message, or null for control frames. */
export function decodeFrame(raw: string): { messageId: string; text: string; chatId: string; sessionWebhook: string } | null {
  let frame: any;
  try {
    frame = JSON.parse(raw);
  } catch {
    return null;
  }
  const topic = frame?.headers?.topic;
  const messageId = String(frame?.headers?.messageId ?? '');
  if (topic !== TOPIC_BOT_MESSAGE || !messageId) return null;
  // data 形态兼容：官方 SDK 假设 data=base64(JSON)，但真实网关推送出现过三种形态
  //（2026-10-18 实测帧 749B 走不到 base64 分支）：①base64 字符串 ②明文 JSON 字符串
  // ③已是对象 / 挂在 event 字段。逐级尝试，全失败时回 null（上层有落盘日志）。
  let payload: any;
  const d = frame.data ?? frame.event;
  if (d && typeof d === 'object') {
    payload = d;
  } else {
    const raw = String(d ?? '');
    try {
      payload = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    } catch {
      try { payload = JSON.parse(raw); } catch { return null; }
    }
  }
  const text = String(payload?.text?.content ?? payload?.content ?? '').trim();
  const chatId = String(payload?.conversationId ?? payload?.senderStaffId ?? payload?.senderNick ?? 'unknown');
  const sessionWebhook = String(payload?.sessionWebhook ?? '');
  if (!text && !sessionWebhook) return null;
  return { messageId, text, chatId, sessionWebhook };
}

/** The per-message ack the stream gateway expects. */
export function ackFrame(messageId: string, ok: boolean): string {
  return JSON.stringify({ code: ok ? 200 : 500, headers: {}, body: '{}', message: ok ? 'OK' : 'rejected' });
}

export class DingTalkStreamTransport implements ImTransport {
  readonly id = 'dingtalk-stream';
  private ws: WebSocket | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private frameWatch: ReturnType<typeof setInterval> | null = null;
  private lastFrameAt = 0;
  private pingTimer: NodeJS.Timeout | null = null;
  private closedByUs = false;

  constructor(
    private readonly creds: DingTalkCredentials,
    private readonly gatewayUrl: string = 'https://api.dingtalk.com/v1.0/gateway/connections/open',
    private readonly postJson: (url: string, body: unknown) => Promise<any> = defaultPostJson,
  ) {}

  async start(ctx: TransportContext): Promise<void> {
    // 幂等保护：重连路径（close → 定时 start）先清掉旧连接/旧定时器，连续断线时
    // 不会堆积多个并发 ws（旧连接可能把消息收走后 ack 失败——消息静默丢失）。
    await this.stop();
    this.closedByUs = false;
    imLog(`钉钉 Stream 连接中（appKey=${this.creds.appKey.slice(0, 6)}…）`);
    let endpoint: string; let ticket: string;
    try {
      ({ endpoint, ticket } = await openConnection(this.gatewayUrl, this.creds, this.postJson));
    } catch (err) {
      // 网关失败（超时/网络/凭据）必须可见且可恢复：close handler 只管 ws 层，
      // 这一步挂了此前既无日志也无重试——通道静默死亡。
      imLog(`钉钉网关连接失败：${String((err as Error)?.message ?? err).slice(0, 160)}，5 秒后重试`);
      if (!this.closedByUs) this.retryTimer = setTimeout(() => void this.start(ctx).catch(e => imLog(`重试失败：${String(e).slice(0, 120)}`)), 5000);
      return;
    }
    const url = new URL(endpoint);
    if (ticket) url.searchParams.set('ticket', ticket);
    const ws = new WebSocket(url, { handshakeTimeout: 15000 });
    this.ws = ws;
    // Attach 'message' before awaiting 'open': a frame riding in the same TCP
    // segment as the handshake response is processed synchronously after 'open'
    // fires, and would be dropped if the listener were attached a microtask late.
    ws.on('message', (raw) => {
      this.lastFrameAt = Date.now(); // 任何入站帧（含服务端 ping）都是链路存活证据
      const text = String(raw);
      if (text.includes('"ping"')) {
        ws.send(JSON.stringify({ code: 200, headers: {}, body: '{}', message: 'pong' }));
        return;
      }
      if (!text.includes('"ping"')) {
        // 观测点：收到任何非 ping 帧都落盘（此前 decode 失败静默丢弃——连接活着
        // 却「收不到消息」时无法区分帧没到还是解析挂了，2026-10-18 实测盲区）。
        const frame = (() => { try { return JSON.parse(text); } catch { return null; } })();
        const topic = frame?.headers?.topic ?? '(无 topic)';
        const dataLen = String(frame?.data ?? '').length;
        imLog(`收到事件帧：topic=${topic}，data ${dataLen}B，messageId=${String(frame?.headers?.messageId ?? '-').slice(0, 18)}`);
        // 终极观测：真实 payload 原文（截 800 字）——text/sessionWebhook 的提取路径
        // 必须按真实结构适配，不能再猜（用户发 /bind 被当 free text 的教训）。
        const d = frame?.data ?? frame?.event;
        const decode = (x: string) => {
          try { const j = JSON.parse(x); return JSON.stringify(j); } catch { /* not plain json */ }
          try { const j = JSON.parse(Buffer.from(x, 'base64').toString('utf8')); return JSON.stringify(j); } catch { /* not base64 json */ }
          return x;
        };
        const inner = typeof d === 'string' ? decode(d) : JSON.stringify(d);
        imLog(`payload 原文：${String(inner).slice(0, 800)}`);
      }
      const msg = decodeFrame(text);
      if (!msg) { imLog(`事件帧未解码为机器人消息（topic 不符或结构异常），忽略`); return; }
      void ctx
        .onMessage({ chatId: msg.chatId, text: msg.text } satisfies IncomingMessage)
        .then(async (reply) => {
          imLog(`钉钉消息已处理（chat=${msg.chatId.slice(0, 16)}…，回复 ${reply.length} 字）`);
          if (!msg.sessionWebhook) {
            // 「已处理」≠「已送达」：帧内无 sessionWebhook 时回复无处可发（此前静默跳过，
            // 用户在钉钉侧永远看不到回复而日志显示一切正常）。落盘 payload 结构供适配。
            let payloadShape = '(decode 未捕获)';
            try {
              const f = JSON.parse(String(raw));
              const d = f?.data ?? f?.event;
              const inner = typeof d === 'string' ? (() => { try { return JSON.parse(Buffer.from(d, 'base64').toString('utf8')); } catch { try { return JSON.parse(d); } catch { return undefined; } } })() : d;
              payloadShape = JSON.stringify({ dataKeys: inner && typeof inner === 'object' ? Object.keys(inner) : typeof inner, dataPreview: JSON.stringify(inner)?.slice(0, 400) });
            } catch { /* 观测失败不影响主流程 */ }
            imLog(`回复无法送达：帧内无 sessionWebhook。payload=${payloadShape}`);
            ws.send(ackFrame(msg.messageId, true));
            return;
          }
          if (msg.sessionWebhook) {
            // webhook 失败必须 ack false：钉钉会对失败消息重推，静默丢回复无痕迹。
            try {
              // 钉钉 webhook 的 text 消息格式是顶级 text.content（此前写成 content.text，
// 每条回复都被拒 errcode=400201 miss param : text，而 HTTP 200 掩盖了它）
const res = await this.postJson(msg.sessionWebhook, { msgtype: 'text', text: { content: reply } });
              // HTTP 200 ≠ 钉钉接收：sessionWebhook 业务失败（过期/限流/非法消息体）也是 200+errcode≠0
              const errcode = (res as { errcode?: number })?.errcode;
              if (errcode !== undefined && errcode !== 0) imLog(`回复被钉钉拒绝：errcode=${errcode}，errmsg=${String((res as { errmsg?: string })?.errmsg ?? '').slice(0, 120)}`);
            } catch (err) { imLog(`回复发送失败：${String(err).slice(0, 200)}`); ws.send(ackFrame(msg.messageId, false)); return; }
          }
          ws.send(ackFrame(msg.messageId, true));
        })
        .catch((err) => { imLog(`消息处理异常：${String(err).slice(0, 200)}`); ws.send(ackFrame(msg.messageId, false)); });
    });
    // open/error/close handler 必须先于 await 注册：握手失败（超时/代理吞升级
    // 响应）时 error → start() 抛出，close 几乎同时发出——handler 若还在 await
    // 之后就没注册上，close 重连错过 → 通道静默死亡（2026-10-18 实机：日志停在
    // 「连接中」3 分钟零输出，TCP 半开经代理挂着）。
    ws.on('open', () => imLog('钉钉 Stream 已连接'));
    ws.on('error', (err) => { ctx.onStatus?.(`钉钉连接错误：${err.message}`); imLog(`钉钉连接错误：${err.message}`); });
    ws.on('close', () => {
      if (this.closedByUs) return;
      ctx.onStatus?.('钉钉连接断开，5 秒后重连');
      imLog('钉钉连接断开，5 秒后重连');
      setTimeout(() => void this.start(ctx).catch((err) => imLog(`重连失败：${String(err).slice(0, 200)}`)), 5000);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });
    } catch (err) {
      // 握手失败的可见性：此前只 reject 到主进程 stderr（Finder 启动不落盘），
      // 日志停在「连接中」再无下文。恢复由上面已就位的 close handler 驱动。
      imLog(`钉钉 WebSocket 握手失败：${String((err as Error)?.message ?? err).slice(0, 160)}，close 后 5 秒自动重连`);
      throw err;
    }
    // 死链检测：代理/NAT 静默断链时 TCP 不发 FIN/RST，ws 永远不会 close——
    // 通道假活、消息收不到（2026-10-18 实测：连接 7 分钟后消息不到，对端 TCP 已消失
    // 而日志零记录）。服务端 ping 有固定周期；超过 3 分钟任何帧都没有即判死，主动
    // terminate 触发既有 close 重连。不发 ping 帧（协议违规），只做被动观测。
    this.lastFrameAt = Date.now();
    if (this.frameWatch) clearInterval(this.frameWatch);
    this.frameWatch = setInterval(() => {
      if (this.closedByUs || !this.ws) return;
      const silent = Date.now() - this.lastFrameAt;
      if (silent > 180_000) {
        imLog(`超过 ${Math.round(silent / 1000)}s 未收到钉钉任何帧，链路疑似失活，主动重连`);
        try { this.ws.terminate(); } catch { /* close handler 驱动重连 */ }
      }
    }, 15_000);
    // Keep-alive：钉钉 Stream 协议是「服务端发 ping、客户端回 pong」（上面 message 分支）。
    // 客户端主动发 ping 不是协议的一部分，违规帧可能导致网关断开——不发。
    this.pingTimer = null;
  }

  async stop(): Promise<void> {
    this.closedByUs = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    if (this.frameWatch) { clearInterval(this.frameWatch); this.frameWatch = null; }
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState !== WebSocket.CLOSED) await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { ws.terminate(); resolve(); }, 1500);
      ws.once('close', () => { clearTimeout(timer); resolve(); });
      ws.close();
    });
  }
}

const GATEWAY_TIMEOUT_MS = 10_000;
async function defaultPostJson(url: string, body: unknown): Promise<any> {
  // 10s 超时：代理环境下 gateway 请求可能挂死（2026-10-18 实测卡「连接中」2 分钟
  // 无任何后续——fetch 无超时时永不返回，重连逻辑也永远等不到）。
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`钉钉网关 ${res.status}`);
  return res.json();
}

/** Constant-time-ish secret fingerprint for display in the UI. */
export function secretFingerprint(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex').slice(0, 8);
}
