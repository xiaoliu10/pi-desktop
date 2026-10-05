/**
 * LAN remote control: an opt-in, token-gated HTTP+SSE server that lets a
 * phone on the same network view AND control the current workspace. No cloud
 * relay — the desktop itself is the server. Write surface is intentionally
 * narrow: prompt (queue follow-up), stop, and dialog respond — all three
 * delegate to PiBackend, which applies the same validation as the desktop IPC.
 * ZCode 的云中继 + rpc-frame 在这里的等价物 = 局域网直连 + POST 写路由 +
 * SSE 已在广播的 rpc/ui 事件（含 message_update 增量做打字机）。
 */

import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import type { PiEntry, PiEvent, PiRun, PiSession, PiUiRequest } from '../../shared/pi';

export interface RemoteStatus {
  running: boolean;
  port?: number;
  token?: string;
  urls: string[];
  viewers?: number;
}

export type RemoteDialogResponse = { id: string; value?: string; confirmed?: boolean; cancelled?: boolean };

/** Data source the server renders — the same host the desktop UI uses. */
export interface RemoteDataProvider {
  sessions(): PiSession[];
  runs(): PiRun[];
  history(key: string): PiHistoryLite | null;
  version(): string | null;
  /** 写操作：全部委托 PiBackend（与桌面 IPC 同款校验与并发语义）。 */
  prompt(key: string, text: string): Promise<void> | void;
  stop(key: string): Promise<void> | void;
  respond(key: string, generation: string, response: RemoteDialogResponse): void;
  /** 待审批快照：页面刷新后据此恢复审批卡片。 */
  pendingDialogs(key: string): Array<{ generation: string; request: PiUiRequest }>;
}

export interface PiHistoryLite {
  branch: PiEntry[];
}

const MAX_SSE_CLIENTS = 8;
const MAX_BODY_BYTES = 64 * 1024;
/** 超限 body 也读完才回 400（见 readBody），这是中途放弃读取的硬顶。 */
const MAX_HARD_BODY_BYTES = 8 * 1024 * 1024;
const MAX_PROMPT_CHARS = 200_000;

export class RemoteServer {
  private server: http.Server | null = null;
  private token = '';
  private port = 0;
  private sseClients = new Set<http.ServerResponse>();

  constructor(private readonly data: RemoteDataProvider) {}

  get running(): boolean {
    return this.server !== null;
  }

  /** Live events from the pi host are fanned out to connected viewers. */
  publish(event: PiEvent): void {
    if (!this.sseClients.size) return;
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of this.sseClients) {
      try {
        res.write(payload);
      } catch {
        this.sseClients.delete(res);
      }
    }
  }

  async start(preferredPort = 0): Promise<RemoteStatus> {
    if (this.running) return this.status();
    this.token = crypto.randomBytes(16).toString('hex');
    const server = http.createServer((req, res) => void this.handle(req, res));
    this.server = server;
    this.port = await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(preferredPort, '0.0.0.0', () => {
        const addr = server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : preferredPort);
      });
    });
    return this.status();
  }

  async stop(): Promise<RemoteStatus> {
    const server = this.server;
    this.server = null;
    for (const res of this.sseClients) res.end();
    this.sseClients.clear();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    return this.status();
  }

  status(): RemoteStatus {
    if (!this.running) return { running: false, urls: [], viewers: 0 };
    return { running: true, port: this.port, token: this.token, urls: this.urls(), viewers: this.sseClients.size };
  }

  /** LAN view links, one per non-internal IPv4 interface. */
  urls(): string[] {
    if (!this.running) return [];
    const out: string[] = [];
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list ?? []) {
        if (ni.family === 'IPv4' && !ni.internal) {
          out.push(`http://${ni.address}:${this.port}/view?token=${this.token}`);
        }
      }
    }
    if (!out.length) out.push(`http://127.0.0.1:${this.port}/view?token=${this.token}`);
    return out;
  }

  private authorize(req: http.IncomingMessage, url: URL): boolean {
    const candidates = [url.searchParams.get('token') ?? ''];
    const header = req.headers.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) candidates.push(header.slice(7));
    for (const supplied of candidates) {
      if (supplied.length && supplied.length === this.token.length && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(this.token))) return true;
    }
    return false;
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let overflow = false;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          // 超限后继续把 body 读完再拒（边读边 destroy 会让客户端拿到
          // ECONNRESET 而不是 400 响应）；只丢弃内容，硬顶防恶意灌流。
          overflow = true;
          chunks.length = 0;
          if (size > MAX_HARD_BODY_BYTES) { req.destroy(); reject(new Error('请求体过大')); }
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (overflow) { reject(new Error('请求体过大')); return; }
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
      req.on('error', reject);
    });
  }

  private json(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  private isRun(key: unknown): key is string {
    return typeof key === 'string' && key.length > 0 && this.data.runs().some((r) => r.key === key);
  }

  private async handlePost(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const path = url.pathname;
    if (!['/api/prompt', '/api/stop', '/api/respond'].includes(path)) {
      this.json(res, 404, { error: 'not found' });
      return;
    }
    let body: Record<string, unknown>;
    try {
      const raw = await this.readBody(req);
      body = JSON.parse(raw || '{}') as Record<string, unknown>;
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('请求体必须是 JSON 对象');
    } catch (e) {
      this.json(res, 400, { error: String((e as Error).message || e) });
      return;
    }
    try {
      if (path === '/api/prompt') {
        const key = body.key, text = body.text;
        if (!this.isRun(key)) { this.json(res, 404, { error: '会话未连接' }); return; }
        if (typeof text !== 'string' || !text.trim() || text.length > MAX_PROMPT_CHARS) { this.json(res, 400, { error: '消息为空或超过 200000 字符' }); return; }
        await this.data.prompt(key, text);
        this.json(res, 200, { ok: true });
        return;
      }
      if (path === '/api/stop') {
        if (!this.isRun(body.key)) { this.json(res, 404, { error: '会话未连接' }); return; }
        await this.data.stop(body.key);
        this.json(res, 200, { ok: true });
        return;
      }
      // /api/respond
      if (!this.isRun(body.key)) { this.json(res, 404, { error: '会话未连接' }); return; }
      if (typeof body.generation !== 'string' || !body.generation) { this.json(res, 400, { error: '缺少 generation' }); return; }
      const response = body.response;
      if (!response || typeof response !== 'object' || Array.isArray(response) || typeof (response as RemoteDialogResponse).id !== 'string') { this.json(res, 400, { error: 'response 形状无效' }); return; }
      const r = response as RemoteDialogResponse;
      const valueOk = r.value === undefined || typeof r.value === 'string';
      const confirmedOk = r.confirmed === undefined || typeof r.confirmed === 'boolean';
      const cancelledOk = r.cancelled === undefined || typeof r.cancelled === 'boolean';
      const hasPayload = r.value !== undefined || r.confirmed !== undefined || r.cancelled !== undefined;
      if (!valueOk || !confirmedOk || !cancelledOk || !hasPayload) { this.json(res, 400, { error: 'response 形状无效' }); return; }
      this.data.respond(body.key, body.generation, r);
      this.json(res, 200, { ok: true });
    } catch (e) {
      // backend 抛出的业务错误（已过期/不在可发送状态等）原样回给页面。
      this.json(res, 400, { error: String((e as Error).message || e) });
    }
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://local');
      const method = req.method ?? 'GET';
      if (method !== 'GET' && method !== 'POST') {
        res.writeHead(405, { 'allow': 'GET, POST' });
        res.end('method not allowed');
        return;
      }
      if (!this.authorize(req, url)) {
        res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('unauthorized');
        return;
      }
      if (method === 'POST') {
        await this.handlePost(req, res, url);
        return;
      }
      switch (url.pathname) {
        case '/view':
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          res.end(viewerPage());
          return;
        case '/api/state':
          this.json(res, 200, {
            version: this.data.version(),
            sessions: lightSessions(this.data.sessions()),
            runs: lightRuns(this.data.runs(), (key) => this.data.pendingDialogs(key)),
          });
          return;
        case '/api/history': {
          const key = url.searchParams.get('session') ?? '';
          const history = key ? this.data.history(key) : null;
          res.writeHead(history ? 200 : 404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          res.end(JSON.stringify(history ? { branch: history.branch } : { error: 'unknown session' }));
          return;
        }
        case '/api/events': {
          if (this.sseClients.size >= MAX_SSE_CLIENTS) {
            res.writeHead(503);
            res.end('too many viewers');
            return;
          }
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
          res.write(`data: ${JSON.stringify({ type: 'hello' })}\n\n`);
          this.sseClients.add(res);
          req.on('close', () => this.sseClients.delete(res));
          return;
        }
        default:
          res.writeHead(404);
          res.end('not found');
      }
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end('error');
    }
  }
}

function lightSessions(sessions: PiSession[]) {
  return sessions
    .map((s) => ({ key: s.key, name: s.name, cwd: s.cwd, updatedAt: s.updatedAt, owned: s.owned }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 200);
}

function lightRuns(runs: PiRun[], dialogs: (key: string) => Array<{ generation: string; request: PiUiRequest }> = () => []) {
  return runs.map((r) => ({ key: r.key, status: r.status, cwd: r.cwd, pending: r.pending, error: r.error, model: r.model?.name, generation: r.generation, dialogs: dialogs(r.key) }));
}

/** Single-file mobile viewer. Parse of pi entries mirrors the desktop's historyToMessages minimally. */
export function viewerPage(): string {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>PI Desktop · 远程控制</title>
<style>
  :root { color-scheme: light dark; --bg:#f4f4f6; --card:#fff; --line:#e3e3e6; --text:#1c1c1e; --sub:#8a8a90; --accent:#1d1d1f; --user:#e8f0fe; --danger:#ba4236; --chip:#eeeef0; }
  @media (prefers-color-scheme: dark) { :root { --bg:#121316; --card:#212226; --line:#323338; --text:#ececef; --sub:#9a9aa2; --accent:#f2f2f3; --user:#1f2a3d; --danger:#ff6b61; --chip:#2c2d31; } }
  * { box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
  [hidden] { display:none !important; }
  body { margin:0; background:var(--bg); color:var(--text); font:15px/1.55 -apple-system,"PingFang SC",system-ui,sans-serif; }
  header { position:sticky; top:0; z-index:5; background:var(--card); border-bottom:1px solid var(--line); padding:14px 16px 10px; }
  .head-row { display:flex; align-items:center; gap:10px; }
  .head-row h1 { font-size:19px; margin:0; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .head-sub { font-size:13px; color:var(--sub); margin:2px 0 0; }
  .backbtn { border:0; background:none; color:var(--text); font-size:22px; line-height:1; padding:2px 8px 2px 0; display:none; }
  .pill { font-size:11px; padding:3px 10px; border-radius:99px; border:1px solid var(--line); color:var(--sub); flex-shrink:0; }
  .pill.live { color:#0a7d33; border-color:#0a7d3355; }
  .pill.err { color:var(--danger); border-color:var(--danger); }
  .stopbtn { flex-shrink:0; border:1px solid var(--danger); color:var(--danger); background:none; border-radius:8px; font-size:12px; padding:5px 10px; display:none; }
  main { padding:14px 14px 120px; }
  .notice { background:var(--chip); border-radius:12px; padding:12px 14px; font-size:13px; color:var(--sub); margin-bottom:18px; }
  .sect-head { display:flex; align-items:center; gap:10px; margin:2px 2px 2px; }
  .sect-head h2 { font-size:17px; margin:0; flex:1; }
  .refreshbtn { border:1px solid var(--line); background:none; color:var(--text); border-radius:10px; padding:6px 12px; font-size:13px; }
  .sect-sub { color:var(--sub); font-size:13px; margin:2px 2px 12px; }
  .proj-search { width:100%; border:1px solid var(--line); background:var(--card); color:var(--text); border-radius:10px; padding:9px 12px; font:inherit; font-size:14px; margin-bottom:12px; }
  .proj { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:12px; margin-bottom:12px; display:flex; align-items:center; gap:12px; }
  .proj-icon { flex:0 0 42px; height:42px; border-radius:10px; background:var(--chip); display:flex; align-items:center; justify-content:center; font-size:19px; }
  .proj-main { flex:1; min-width:0; cursor:pointer; }
  .proj-name { font-size:15px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .proj-tag { font-size:10px; padding:1px 8px; border:1px solid var(--line); border-radius:99px; color:var(--sub); margin-left:8px; vertical-align:2px; }
  .proj-path { font-size:12px; color:var(--sub); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:ui-monospace,Menlo,monospace; }
  .proj-meta { display:flex; gap:10px; font-size:12px; color:var(--sub); margin-top:3px; }
  .proj-meta .go { margin-left:auto; }
  .proj-add { flex:0 0 38px; height:38px; border:1px solid var(--line); background:none; color:var(--text); border-radius:10px; font-size:19px; line-height:1; }
  .proj.go-live { border-color:#0a7d3355; }
  .proj.go-live .proj-meta { color:#0a7d33; }
  .pending-badge { color:#c47f17; }
  .footnote { text-align:center; color:var(--sub); font-size:11px; margin:26px 0 0; }
  .empty { text-align:center; color:var(--sub); padding:48px 0; font-size:13px; }
  .conn { text-align:center; color:var(--sub); font-size:11px; padding:6px 0 14px; }
  select { appearance:none; background:var(--card); color:var(--text); border:1px solid var(--line); border-radius:8px; padding:6px 8px; max-width:52vw; font-size:13px; }
  .chat-bar { display:flex; gap:8px; align-items:center; margin-bottom:6px; }
  .msg { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:10px 12px; margin:8px 0; overflow-wrap:anywhere; white-space:pre-wrap; }
  .msg.user { background:var(--user); }
  .msg.pending { opacity:.6; }
  .msg .who { font-size:11px; color:var(--sub); margin-bottom:4px; }
  .msg.tool { color:var(--sub); font-size:13px; }
  .msg.think { color:var(--sub); font-size:13px; font-style:italic; }
  .msg.err { color:var(--danger); border-color:var(--danger); }
  .composer { position:fixed; left:0; right:0; bottom:0; z-index:3; background:var(--card); border-top:1px solid var(--line); padding:8px 10px calc(8px + env(safe-area-inset-bottom)); display:flex; gap:8px; align-items:flex-end; }
  .composer textarea { flex:1; resize:none; border:1px solid var(--line); background:var(--bg); color:var(--text); border-radius:10px; padding:9px 10px; font:inherit; font-size:14px; max-height:120px; min-height:38px; }
  .composer textarea:disabled { opacity:.5; }
  .sendbtn { flex-shrink:0; border:0; background:var(--accent); color:var(--bg); border-radius:10px; font-size:14px; padding:9px 16px; }
  .sendbtn:disabled { opacity:.4; }
  .dialogs { position:fixed; left:10px; right:10px; bottom:calc(64px + env(safe-area-inset-bottom)); z-index:4; }
  .dialog-card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:14px; box-shadow:0 8px 30px rgba(0,0,0,.18); }
  .dialog-card .dlg-title { font-size:13px; color:var(--sub); margin-bottom:4px; }
  .dialog-card .dlg-msg { font-size:14px; margin-bottom:10px; overflow-wrap:anywhere; white-space:pre-wrap; max-height:30vh; overflow:auto; }
  .dialog-card .dlg-opts { display:flex; flex-direction:column; gap:8px; }
  .dlg-opt { border:1px solid var(--line); background:var(--bg); color:var(--text); border-radius:10px; padding:10px 12px; font:inherit; font-size:14px; text-align:left; }
  .dlg-opt b { display:block; }
  .dlg-opt small { color:var(--sub); font-size:12px; }
  .dlg-row { display:flex; gap:8px; margin-top:10px; }
  .dlg-row .dlg-primary { flex:1; border:0; background:var(--accent); color:var(--bg); border-radius:10px; padding:10px; font:inherit; font-size:14px; }
  .dlg-row .dlg-ghost { border:1px solid var(--line); background:none; color:var(--text); border-radius:10px; padding:10px 14px; font:inherit; font-size:14px; }
  .dialog-card input, .dialog-card textarea { width:100%; border:1px solid var(--line); background:var(--bg); color:var(--text); border-radius:10px; padding:10px; font:inherit; font-size:14px; }
  .ask-multi { font-size:11px; color:var(--sub); margin-left:6px; }
</style>
</head>
<body>
<header>
  <div class="head-row">
    <button class="backbtn" id="back" aria-label="返回">&#8249;</button>
    <h1 id="title">PI Desktop 远程控制</h1>
    <span class="pill" id="status">离线</span>
    <button class="stopbtn" id="stopbtn">停止</button>
  </div>
  <p class="head-sub" id="subtitle">已连接到当前桌面窗口</p>
</header>
<main id="projects">
  <div class="notice">本次连接可以查看当前设备上已打开的项目、任务和会话；二维码失效后需要回到桌面端重新连接。</div>
  <div class="sect-head"><h2>当前设备上的工作区和任务</h2><button class="refreshbtn" id="refresh">&#8635; 刷新</button></div>
  <div class="sect-sub" id="projStat">读取中…</div>
  <input class="proj-search" id="projSearch" placeholder="搜索项目或任务…" disabled>
  <div id="projList"></div>
  <div class="footnote">本地执行 · 数据不会离开你的电脑</div>
</main>
<main id="chat" hidden>
  <div class="chat-bar">
    <select id="session"></select>
  </div>
  <div id="feed"><div class="empty">正在连接桌面端…</div></div>
</main>
<div class="dialogs" id="dialogs" hidden></div>
<form class="composer" id="composer" hidden>
  <textarea id="input" rows="1" placeholder="连接桌面端后可发送…" disabled></textarea>
  <button class="sendbtn" id="send" type="submit" disabled>发送</button>
</form>
<div class="conn" id="conn"></div>
<script>
const qs = new URLSearchParams(location.search);
const TOKEN = qs.get('token') || '';
const api = (p) => fetch(p + (p.includes('?') ? '&' : '?') + 'token=' + TOKEN).then(r => { if (r.status === 401) throw new Error('token'); return r.json(); });
function post(p, body) {
  return fetch(p + '?token=' + TOKEN, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; });
}
let sessions = [], runs = new Map(), current = null, reconnectTimer = null;
let chatView = false;
// id → { key, generation, request }；页面刷新后由 /api/state 的 runs[].dialogs 恢复。
let dialogs = new Map();
// 流式打字机：当前会话正在拼装的助手消息块（等价桌面 stream-delta）。
let liveBlocks = null;
// 乐观发送：POST 成功但历史尚未回显的用户消息。
let optimistic = [];
let lastEntries = [];

function escapeHtml(s) { return String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }

// ---- 项目视图（ZCode 同款：扫码进来是工作区卡片列表） ----
function projects() {
  const map = new Map();
  for (const s of sessions) {
    const cwd = s.cwd || '其他';
    if (!map.has(cwd)) map.set(cwd, { cwd, name: (cwd.split(/[\\\\/]/).filter(Boolean).pop() || cwd), sessions: [], latest: 0 });
    const g = map.get(cwd);
    g.sessions.push(s);
    g.latest = Math.max(g.latest, s.updatedAt || 0);
  }
  return [...map.values()].sort((a, b) => b.latest - a.latest);
}
let stateLoaded = false;
function renderProjects() {
  const q = (document.getElementById('projSearch').value || '').toLowerCase();
  if (!stateLoaded) {
    document.getElementById('projStat').textContent = '读取中…';
    document.getElementById('projList').innerHTML = '<div class="empty">正在连接桌面端…</div>';
    return;
  }
  const groups = projects();
  document.getElementById('projStat').textContent = groups.length + ' 个工作区 · ' + sessions.length + ' 个任务';
  const list = document.getElementById('projList');
  const visible = groups.filter(g => !q || g.name.toLowerCase().includes(q) || g.cwd.toLowerCase().includes(q) || g.sessions.some(s => (s.name || '').toLowerCase().includes(q)));
  if (!visible.length) { list.innerHTML = '<div class="empty">没有匹配的项目</div>'; return; }
  list.innerHTML = visible.map(g => {
    const live = g.sessions.some(s => { const r = runs.get(s.key); return r && (r.status === 'running' || r.status === 'starting'); });
    const keys = new Set(g.sessions.map(x => x.key));
    const pending = [...dialogs.values()].filter(d => keys.has(d.key)).length;
    return '<div class="proj' + (live ? ' go-live' : '') + '" data-open="' + encodeURIComponent(g.cwd) + '">'
      + '<div class="proj-icon">&#128193;</div>'
      + '<div class="proj-main">'
      + '<div class="proj-name">' + escapeHtml(g.name) + '<span class="proj-tag">本地</span></div>'
      + '<div class="proj-path">' + escapeHtml(g.cwd) + '</div>'
      + '<div class="proj-meta"><span>' + g.sessions.length + ' 个任务</span>' + (live ? '<span>运行中</span>' : '') + (pending ? '<span class="pending-badge">' + pending + ' 待审批</span>' : '') + '<span class="go">&#8250;</span></div>'
      + '</div>'
      + '<button class="proj-add" aria-label="新建任务">+</button>'
      + '</div>';
  }).join('');
}
document.getElementById('projList').addEventListener('click', e => {
  const target = e.target.closest('[data-open]');
  if (!target) return;
  const cwd = decodeURIComponent(target.getAttribute('data-open'));
  const group = projects().find(g => g.cwd === cwd);
  const latest = group && group.sessions.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
  if (latest) showChat(latest.key, true);
});
document.getElementById('projSearch').addEventListener('input', renderProjects);
document.getElementById('refresh').addEventListener('click', () => loadState());

// ---- 视图切换 ----
function showProjects() {
  chatView = false;
  document.getElementById('projects').hidden = false;
  document.getElementById('chat').hidden = true;
  document.getElementById('composer').hidden = true;
  document.getElementById('back').style.display = 'none';
  document.getElementById('title').textContent = 'PI Desktop 远程控制';
  document.getElementById('subtitle').textContent = '已连接到当前桌面窗口';
  document.getElementById('stopbtn').style.display = 'none';
  projectsPill();
  renderDialog(); // 清掉对话视图残留的审批 overlay
  renderProjects();
}
// 项目视图的聚合状态 pill：按 runs 统计运行数（不从界面文案反推）。
function projectsPill() {
  const el = document.getElementById('status');
  const running = [...runs.values()].filter(r => r.status === 'running' || r.status === 'starting').length;
  el.className = 'pill' + (running ? ' live' : '');
  el.textContent = running ? running + ' 个运行中' : '空闲';
}
function showChat(key, focusInput) {
  chatView = true;
  current = key; liveBlocks = null; optimistic = []; lastEntries = [];
  document.getElementById('projects').hidden = true;
  document.getElementById('chat').hidden = false;
  document.getElementById('composer').hidden = false;
  document.getElementById('back').style.display = 'inline-block'; // CSS 默认 none，需显式显示
  // 会话选择器只列同项目（cwd）的会话，避免长下拉找不到项目（ZCode 项目→任务两级结构）。
  const mine = sessions.find(s => s.key === key);
  const cwd = mine ? mine.cwd : null;
  const sel = document.getElementById('session');
  sel.innerHTML = '';
  for (const s of sessions.filter(x => !cwd || x.cwd === cwd)) {
    const o = document.createElement('option');
    o.value = s.key; o.textContent = s.name || s.key;
    if (s.key === current) o.selected = true;
    sel.appendChild(o);
  }
  loadHistory(); renderDialog(); renderComposer(); statusPill();
  if (focusInput) setTimeout(() => { const ta = document.getElementById('input'); ta.focus(); }, 60);
}
document.getElementById('back').addEventListener('click', showProjects);
document.getElementById('session').addEventListener('change', e => {
  current = e.target.value; liveBlocks = null; optimistic = []; lastEntries = [];
  loadHistory(); renderDialog(); renderComposer(); statusPill();
});
function statusPill() {
  const el = document.getElementById('status');
  const mine = current && runs.get(current);
  const st = mine ? mine.status : 'idle';
  const active = st === 'running' || st === 'starting';
  el.className = 'pill' + (active ? ' live' : st === 'error' ? ' err' : '');
  let label = active ? '运行中' : st === 'error' ? '出错' : st === 'stopping' ? '停止中' : '空闲';
  if (active && mine && mine.pending > 0) label += ' · 排队 ' + mine.pending;
  el.textContent = label;
  if (chatView) {
    const s = sessions.find(x => x.key === current);
    const group = s && projects().find(g => g.cwd === s.cwd);
    document.getElementById('title').textContent = (group && group.name) || '工作区';
    document.getElementById('subtitle').textContent = s ? (s.name || s.key) : '';
    document.getElementById('stopbtn').style.display = mine && ['running', 'starting', 'stopping'].includes(st) ? '' : 'none';
  }
}

function renderComposer() {
  const mine = current && runs.get(current);
  const ta = document.getElementById('input'), btn = document.getElementById('send');
  const ok = !!mine;
  ta.disabled = !ok; btn.disabled = !ok;
  ta.placeholder = ok ? '发消息…（Enter 发送，Shift+Enter 换行）' : '该会话未连接（在桌面端打开后可发送）';
}

// ---- 历史渲染 + 乐观气泡 ----
function render(entries) {
  if (Array.isArray(entries)) lastEntries = entries;
  const feed = document.getElementById('feed');
  const out = [];
  const seenUser = new Set();
  for (const e of lastEntries) {
    if (e.type !== 'message' || !e.message) continue;
    const m = e.message, role = m.role || '';
    if (role === 'user') { const t = textOf(m.content); seenUser.add(t); out.push(bubble('用户', t, 'user')); }
    else if (role === 'assistant') {
      if (typeof m.content === 'string') out.push(bubble('助手', m.content, ''));
      else if (Array.isArray(m.content)) for (const b of m.content) {
        if (b && b.type === 'text' && b.text) out.push(bubble('助手', b.text, ''));
        else if (b && b.type === 'toolCall') out.push(bubble('工具 · ' + (b.name || 'tool'), previewArgs(b.arguments), 'tool'));
      }
      if (m.errorMessage) out.push(bubble('错误', m.errorMessage, 'err'));
    } else if (role === 'toolResult') {
      const t = textOf(m.content).split('\\n')[0] || '';
      if (t) out.push(bubble('结果', t, 'tool'));
    }
  }
  optimistic = optimistic.filter(t => !seenUser.has(t));
  for (const t of optimistic) out.push(bubble('用户', t, 'user pending'));
  feed.innerHTML = out.length ? out.join('') : '<div class="empty">这个会话还没有内容</div>';
  window.scrollTo(0, document.body.scrollHeight);
}
function bubble(who, text, cls) {
  return '<div class="msg ' + cls + '"><div class="who">' + escapeHtml(who) + '</div>' + escapeHtml(String(text ?? '')).slice(0, 8000) + '</div>';
}
function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(b => b && b.type === 'text').map(b => b.text).join('');
  return '';
}
function previewArgs(args) {
  if (args && typeof args === 'object') {
    const v = args.command || args.cmd || args.file || args.path || args.pattern;
    if (typeof v === 'string') return v.split('\\n')[0];
    try { return JSON.stringify(args).slice(0, 200); } catch { return ''; }
  }
  return String(args ?? '');
}

// ---- 流式打字机（桌面 stream-delta.ts 的等价精简版） ----
function applyDelta(delta) {
  const type = String(delta.type || '');
  const index = Math.max(0, Number(delta.contentIndex || 0));
  if (type === 'start') { liveBlocks = []; return false; }
  if (!liveBlocks) liveBlocks = [];
  const ensure = (init) => {
    while (liveBlocks.length <= index) liveBlocks.push({});
    const cur = liveBlocks[index];
    if (!cur || typeof cur !== 'object' || cur.type === undefined) liveBlocks[index] = Object.assign({}, init);
    return liveBlocks[index];
  };
  if (type === 'text_start') ensure({ type: 'text', text: '' });
  else if (type === 'text_delta') { const b = ensure({ type: 'text', text: '' }); b.text = String(b.text || '') + String(delta.delta || ''); }
  else if (type === 'text_end') { const b = ensure({ type: 'text', text: '' }); b.text = String(delta.content || b.text || ''); }
  else if (type === 'thinking_start') ensure({ type: 'thinking', thinking: '' });
  else if (type === 'thinking_delta') { const b = ensure({ type: 'thinking', thinking: '' }); b.thinking = String(b.thinking || '') + String(delta.delta || ''); }
  else if (type === 'thinking_end') { const b = ensure({ type: 'thinking', thinking: '' }); b.thinking = String(delta.content || b.thinking || ''); }
  else if (type === 'toolcall_start') ensure({ type: 'toolCall', name: 'tool', arguments: {} });
  else if (type === 'toolcall_delta') { const b = ensure({ type: 'toolCall', name: 'tool', arguments: {} }); b._argsRaw = String(b._argsRaw || '') + String(delta.delta || ''); }
  else if (type === 'toolcall_end') { const tc = delta.toolCall; if (tc && typeof tc === 'object') liveBlocks[index] = Object.assign({}, tc); }
  return type === 'done' || type === 'error';
}
function renderLive() {
  const old = document.getElementById('live');
  if (old) old.remove();
  if (!liveBlocks || !liveBlocks.length) return;
  let html = '';
  for (const b of liveBlocks) {
    if (b.type === 'text' && b.text) html += bubble('助手', b.text, '');
    else if (b.type === 'thinking' && b.thinking) html += bubble('思考', b.thinking, 'think');
    else if (b.type === 'toolCall') html += bubble('工具 · ' + (b.name || 'tool'), previewArgs(b.arguments || b._argsRaw), 'tool');
  }
  if (!html) return;
  const div = document.createElement('div');
  div.id = 'live'; div.innerHTML = html;
  document.getElementById('feed').appendChild(div);
  window.scrollTo(0, document.body.scrollHeight);
}
// ---- 审批卡片 ----
function renderDialog() {
  const box = document.getElementById('dialogs');
  // 审批卡只在对话视图显示（项目视图一律隐藏，避免悬浮在列表上）；项目卡片上以
  // 「N 待审批」徽标引导用户进入对应会话处理。
  const d = !chatView ? null : [...dialogs.values()].find(x => x.key === current);
  if (!d) { box.hidden = true; box.innerHTML = ''; return; }
  const r = d.request;
  const isAsk = r.method === 'input' && r.title === 'desktop-ask';
  let html = '<div class="dialog-card"><div class="dlg-title">' + escapeHtml((r.title === 'desktop-ask' ? '需要你的选择' : r.title) || '需要你的确认') + '</div>';
  html += '<div id="dlg-body"></div></div>';
  box.innerHTML = html;
  box.hidden = false;
  const holder = box.querySelector('#dlg-body');
  if (isAsk) { renderAsk(holder, d); return; }
  if (r.message) { const p = document.createElement('div'); p.className = 'dlg-msg'; p.textContent = r.message; holder.appendChild(p); }
  if (r.method === 'confirm') {
    const row = document.createElement('div'); row.className = 'dlg-row';
    row.appendChild(dlgBtn('拒绝', 'dlg-ghost', () => respondDialog(d, { id: r.id, cancelled: true })));
    row.appendChild(dlgBtn('允许', 'dlg-primary', () => respondDialog(d, { id: r.id, confirmed: true })));
    holder.appendChild(row);
  } else if (r.method === 'select') {
    const wrap = document.createElement('div'); wrap.className = 'dlg-opts';
    (r.options || []).forEach(opt => wrap.appendChild(dlgBtn(opt, 'dlg-opt', () => respondDialog(d, { id: r.id, value: opt }))));
    holder.appendChild(wrap);
    const row = document.createElement('div'); row.className = 'dlg-row';
    row.appendChild(dlgBtn('取消', 'dlg-ghost', () => respondDialog(d, { id: r.id, cancelled: true })));
    holder.appendChild(row);
  } else {
    const isEditor = r.method === 'editor';
    const el = document.createElement(isEditor ? 'textarea' : 'input');
    if (isEditor) el.rows = 3; else el.type = 'text';
    if (r.placeholder) el.placeholder = r.placeholder;
    el.value = r.prefill || '';
    holder.appendChild(el);
    const row = document.createElement('div'); row.className = 'dlg-row';
    row.appendChild(dlgBtn('取消', 'dlg-ghost', () => respondDialog(d, { id: r.id, cancelled: true })));
    row.appendChild(dlgBtn('提交', 'dlg-primary', () => respondDialog(d, { id: r.id, value: el.value })));
    holder.appendChild(row);
    setTimeout(() => el.focus(), 50);
  }
}
function dlgBtn(label, cls, onClick) {
  const b = document.createElement('button');
  b.className = cls; b.type = 'button'; b.textContent = label;
  if (cls === 'dlg-opt') { const parts = label.split(' — '); b.innerHTML = '<b>' + escapeHtml(parts[0]) + '</b>' + (parts[1] ? '<small>' + escapeHtml(parts.slice(1).join(' — ')) + '</small>' : ''); }
  b.addEventListener('click', onClick);
  return b;
}
// desktop-ask 富问题卡片：payload 在 placeholder，回答以 JSON 提交（与桌面 AskQuestionCard 同格式）。
function renderAsk(holder, d) {
  let payload = null;
  try { payload = JSON.parse(d.request.placeholder || ''); } catch { /* 非法载荷按普通 input 处理 */ }
  if (!payload || !Array.isArray(payload.questions) || !payload.questions.length) {
    holder.innerHTML = '';
    const p = document.createElement('div'); p.className = 'dlg-msg'; p.textContent = d.request.message || ''; holder.appendChild(p);
    const row = document.createElement('div'); row.className = 'dlg-row';
    const input = document.createElement('input'); input.type = 'text';
    row.appendChild(dlgBtn('取消', 'dlg-ghost', () => respondDialog(d, { id: d.request.id, cancelled: true })));
    const submit = () => respondDialog(d, { id: d.request.id, value: input.value });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    row.insertBefore(input, row.firstChild);
    row.appendChild(dlgBtn('提交', 'dlg-primary', submit));
    holder.appendChild(row);
    return;
  }
  holder.innerHTML = '';
  const picked = payload.questions.map(() => []);
  const others = payload.questions.map(() => '');
  const rebuild = () => {
    holder.innerHTML = '';
    payload.questions.forEach((q, qi) => {
      const sec = document.createElement('div'); sec.style.marginBottom = '10px';
      const head = document.createElement('div'); head.className = 'dlg-title';
      head.textContent = (q.header ? q.header + ' · ' : '') + q.question + (q.multiSelect ? '（可多选）' : '');
      sec.appendChild(head);
      (q.options || []).forEach(o => {
        const on = picked[qi].indexOf(o.label) >= 0;
        const b = dlgBtn((on ? '✓ ' : '') + o.label + (o.description ? ' — ' + o.description : ''), 'dlg-opt', () => {
          if (q.multiSelect) {
            const at = picked[qi].indexOf(o.label);
            if (at >= 0) picked[qi].splice(at, 1); else picked[qi].push(o.label);
          } else picked[qi] = on ? [] : [o.label];
          rebuild();
        });
        if (on) b.style.borderColor = 'var(--accent)';
        sec.appendChild(b);
      });
      holder.appendChild(sec);
    });
    const row = document.createElement('div'); row.className = 'dlg-row';
    row.appendChild(dlgBtn('取消', 'dlg-ghost', () => respondDialog(d, { id: d.request.id, cancelled: true })));
    const complete = picked.every(labels => labels.length > 0);
    const submitBtn = dlgBtn('提交', 'dlg-primary', () => {
      if (!complete) return;
      const answers = payload.questions.map((q, qi) => ({
        header: q.header || String(q.question || '').slice(0, 12),
        answers: picked[qi].map(l => (l === '__other__' ? (others[qi] || '').trim() : l)),
      }));
      respondDialog(d, { id: d.request.id, value: JSON.stringify(answers) });
    });
    if (!complete) submitBtn.style.opacity = '.5';
    row.appendChild(submitBtn);
    holder.appendChild(row);
  };
  rebuild();
}
function respondDialog(d, response) {
  post('/api/respond', { key: d.key, generation: d.generation, response })
    .then(() => { dialogs.delete(d.request.id); renderDialog(); })
    .catch(e => { document.getElementById('conn').textContent = String(e.message || e); });
}
function seedDialogs(state) {
  for (const r of state.runs || []) for (const dg of r.dialogs || []) {
    dialogs.set(dg.request.id, { key: r.key, generation: dg.generation, request: dg.request });
  }
  renderDialog();
}

// ---- 数据加载 ----
async function loadState() {
  try {
    const s = await api('/api/state');
    sessions = s.sessions || [];
    runs = new Map((s.runs || []).map(r => [r.key, r]));
    dialogs = new Map();
    stateLoaded = true;
    seedDialogs(s);
    document.getElementById('projSearch').disabled = false;
    document.getElementById('conn').textContent = '已连接 · pi ' + (s.version || '');
    if (chatView) { // 对话视图：刷当前项目 select 选择器 + 历史
      const sel = document.getElementById('session');
      const cur = current;
      const cwd = (sessions.find(x => x.key === cur) || {}).cwd || null;
      sel.innerHTML = '';
      for (const x of sessions.filter(x2 => !cwd || x2.cwd === cwd)) {
        const o = document.createElement('option');
        o.value = x.key; o.textContent = x.name || x.key;
        if (x.key === cur) o.selected = true;
        sel.appendChild(o);
      }
      statusPill(); renderComposer(); await loadHistory();
    } else {
      projectsPill();
      renderProjects();
    }
  } catch (e) {
    document.getElementById('conn').textContent = String(e.message || e);
    document.getElementById('projStat').textContent = '连接失败';
    document.getElementById('projList').innerHTML = '<div class="empty">无法连接桌面端（二维码可能已失效，请回桌面端重新扫码）</div>';
  }
}
async function loadHistory() {
  if (!current) { document.getElementById('feed').innerHTML = '<div class="empty">还没有会话</div>'; return; }
  try { const h = await api('/api/history?session=' + encodeURIComponent(current)); render(h.branch || []); }
  catch (e) { document.getElementById('feed').innerHTML = '<div class="empty">无法读取会话</div>'; }
}

// ---- SSE：run 状态 / 审批 / 流式增量 ----
function listen() {
  const es = new EventSource('/api/events?token=' + TOKEN);
  es.onopen = () => { document.getElementById('conn').textContent = '实时同步中'; if (!chatView) projectsPill(); };
  es.onerror = () => { es.close(); document.getElementById('conn').textContent = '连接断开，重试中…'; clearTimeout(reconnectTimer); reconnectTimer = setTimeout(listen, 3000); };
  es.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'run') {
      runs.set(msg.run.key, Object.assign({}, runs.get(msg.run.key), lite(msg.run)));
      if (chatView) { statusPill(); renderComposer(); } else { renderProjects(); }
    }
    else if (msg.type === 'sessions-changed') loadState();
    else if (msg.type === 'ui') {
      dialogs.set(msg.request.id, { key: msg.key, generation: msg.generation, request: msg.request });
      if (msg.key === current && chatView) renderDialog();
    }
    else if (msg.type === 'rpc' && (msg.event.type === 'ui-expired' || msg.event.type === 'ui-resolved')) {
      if (dialogs.delete(msg.event.id)) renderDialog();
    }
    else if (msg.type === 'rpc' && msg.key === current && chatView) {
      const t = msg.event && msg.event.type;
      if (t === 'message_update' && msg.event.assistantMessageEvent) {
        const ended = applyDelta(msg.event.assistantMessageEvent);
        renderLive();
        if (ended) { liveBlocks = null; renderLive(); debouncedHistory(); }
      } else if (t === 'message_end' || t === 'agent_settled' || t === 'auto_retry_start' || t === 'compaction_start') {
        liveBlocks = null; renderLive(); debouncedHistory();
      } else if (t === 'queue_update') {
        statusPill();
      }
    }
  };
}
function lite(r) { return { key: r.key, status: r.status, cwd: r.cwd, pending: r.pending, error: r.error, generation: r.generation }; }
let histTimer = null;
function debouncedHistory() { clearTimeout(histTimer); histTimer = setTimeout(loadHistory, 400); }

// ---- 发送 / 停止 ----
const ta = document.getElementById('input');
ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 120) + 'px'; });
ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); document.getElementById('composer').requestSubmit(); } });
document.getElementById('composer').addEventListener('submit', e => {
  e.preventDefault();
  const text = ta.value.trim();
  if (!text || !current) return;
  post('/api/prompt', { key: current, text })
    .then(() => { optimistic.push(text); ta.value = ''; ta.style.height = 'auto'; render(null); document.getElementById('conn').textContent = '已发送'; })
    .catch(err => { document.getElementById('conn').textContent = '发送失败：' + String(err.message || err); });
});
document.getElementById('stopbtn').addEventListener('click', () => {
  if (!current) return;
  post('/api/stop', { key: current })
    .then(() => { document.getElementById('conn').textContent = '已请求停止'; })
    .catch(err => { document.getElementById('conn').textContent = '停止失败：' + String(err.message || err); });
});

showProjects();
loadState(); listen();
<\/script>
</body>
</html>`;
}
