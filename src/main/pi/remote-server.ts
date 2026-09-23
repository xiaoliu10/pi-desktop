/**
 * LAN remote viewer: an opt-in, token-gated, read-only HTTP+SSE server that
 * lets a phone on the same network open the current workspace. No cloud
 * relay — the desktop itself is the server. Write access is deliberately
 * absent: every route is GET and only serves pi state.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import type { PiEntry, PiEvent, PiRun, PiSession } from '../../shared/pi';

export interface RemoteStatus {
  running: boolean;
  port?: number;
  token?: string;
  urls: string[];
  viewers?: number;
}

/** Data source the server renders — the same host the desktop UI uses. */
export interface RemoteDataProvider {
  sessions(): PiSession[];
  runs(): PiRun[];
  history(key: string): PiHistoryLite | null;
  version(): string | null;
}

export interface PiHistoryLite {
  branch: PiEntry[];
}

const MAX_SSE_CLIENTS = 8;

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

  private authorize(url: URL): boolean {
    const supplied = url.searchParams.get('token') ?? '';
    if (!supplied.length || supplied.length !== this.token.length) return false;
    return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(this.token));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://local');
      if (req.method !== 'GET' || !this.authorize(url)) {
        res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('unauthorized');
        return;
      }
      switch (url.pathname) {
        case '/view':
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          res.end(viewerPage());
          return;
        case '/api/state':
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          res.end(JSON.stringify({ version: this.data.version(), sessions: lightSessions(this.data.sessions()), runs: lightRuns(this.data.runs()) }));
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

function lightRuns(runs: PiRun[]) {
  return runs.map((r) => ({ key: r.key, status: r.status, cwd: r.cwd, pending: r.pending, error: r.error, model: r.model?.name }));
}

/** Single-file mobile viewer. Parse of pi entries mirrors the desktop's historyToMessages minimally. */
export function viewerPage(): string {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>PI Desktop · 工作区</title>
<style>
  :root { color-scheme: light dark; --bg:#f7f7f8; --card:#fff; --line:#e5e5e7; --text:#1c1c1e; --sub:#7c7c82; --accent:#1d1d1f; --user:#e8f0fe; }
  @media (prefers-color-scheme: dark) { :root { --bg:#111214; --card:#1c1d20; --line:#2c2d31; --text:#e8e8ea; --sub:#9a9aa1; --accent:#f2f2f3; --user:#1f2a3d; } }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  body { margin:0; background:var(--bg); color:var(--text); font:15px/1.55 -apple-system,"PingFang SC",system-ui,sans-serif; }
  header { position:sticky; top:0; z-index:2; background:var(--card); border-bottom:1px solid var(--line); padding:10px 14px; display:flex; align-items:center; gap:10px; }
  header h1 { font-size:15px; margin:0; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .pill { font-size:11px; padding:3px 9px; border-radius:99px; border:1px solid var(--line); color:var(--sub); flex-shrink:0; }
  .pill.live { color:#0a7d33; border-color:#0a7d3355; }
  .pill.err { color:#ba4236; border-color:#ba423655; }
  select { appearance:none; background:var(--card); color:var(--text); border:1px solid var(--line); border-radius:8px; padding:6px 8px; max-width:46vw; font-size:13px; }
  main { padding:12px 12px 40px; }
  .msg { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:10px 12px; margin:8px 0; overflow-wrap:anywhere; white-space:pre-wrap; }
  .msg.user { background:var(--user); }
  .msg .who { font-size:11px; color:var(--sub); margin-bottom:4px; }
  .msg.tool { color:var(--sub); font-size:13px; }
  .msg.err { color:#ba4236; border-color:#ba423655; }
  .empty { text-align:center; color:var(--sub); padding:48px 0; font-size:13px; }
  .conn { text-align:center; color:var(--sub); font-size:11px; padding:6px 0 14px; }
</style>
</head>
<body>
<header>
  <select id="session"></select>
  <h1 id="title">工作区</h1>
  <span class="pill" id="status">离线</span>
</header>
<main id="feed"><div class="empty">正在连接桌面端…</div></main>
<div class="conn" id="conn"></div>
<script>
const qs = new URLSearchParams(location.search);
const TOKEN = qs.get('token') || '';
const api = (p) => fetch(p + (p.includes('?') ? '&' : '?') + 'token=' + TOKEN).then(r => { if (r.status === 401) throw new Error('token'); return r.json(); });
let sessions = [], runs = new Map(), current = null, reconnectTimer = null;

function pickSession() {
  const sel = document.getElementById('session');
  const active = [...runs.values()].find(r => r.status === 'running' || r.status === 'starting');
  current = current || (active && active.key) || (sessions[0] && sessions[0].key) || null;
  sel.innerHTML = '';
  for (const s of sessions.slice(0, 200)) {
    const o = document.createElement('option');
    o.value = s.key; o.textContent = s.name;
    if (s.key === current) o.selected = true;
    sel.appendChild(o);
  }
}
document.getElementById('session').addEventListener('change', e => { current = e.target.value; loadHistory(); });

function statusPill() {
  const el = document.getElementById('status');
  const mine = current && runs.get(current);
  const st = mine ? mine.status : 'idle';
  el.className = 'pill' + (st === 'running' || st === 'starting' ? ' live' : st === 'error' ? ' err' : '');
  el.textContent = st === 'running' || st === 'starting' ? '运行中' : st === 'error' ? '出错' : st === 'stopping' ? '停止中' : '空闲';
  document.getElementById('title').textContent = mine ? (mine.cwd.split('/').pop() || '工作区') : '工作区';
}

function render(entries) {
  const feed = document.getElementById('feed');
  const out = [];
  for (const e of entries) {
    if (e.type !== 'message' || !e.message) continue;
    const m = e.message, role = m.role || '';
    if (role === 'user') out.push(bubble('用户', textOf(m.content), 'user'));
    else if (role === 'assistant') {
      if (typeof m.content === 'string') out.push(bubble('助手', m.content, ''));
      else if (Array.isArray(m.content)) for (const b of m.content) {
        if (b && b.type === 'text' && b.text) out.push(bubble('助手', b.text, ''));
        else if (b && b.type === 'toolCall') out.push(bubble('工具 · ' + (b.name || 'tool'), JSON.stringify(b.arguments ?? {}), 'tool'));
      }
      if (m.errorMessage) out.push(bubble('错误', m.errorMessage, 'err'));
    } else if (role === 'toolResult') {
      const t = textOf(m.content).split('\\n')[0] || '';
      if (t) out.push(bubble('结果', t, 'tool'));
    }
  }
  feed.innerHTML = out.length ? out.join('') : '<div class="empty">这个会话还没有内容</div>';
  window.scrollTo(0, document.body.scrollHeight);
}
function bubble(who, text, cls) {
  return '<div class="msg ' + cls + '"><div class="who">' + who + '</div>' + escapeHtml(String(text ?? '')).slice(0, 8000) + '</div>';
}
function escapeHtml(s) { return s.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(b => b && b.type === 'text').map(b => b.text).join('');
  return '';
}

async function loadState() {
  try {
    const s = await api('/api/state');
    sessions = s.sessions || [];
    runs = new Map((s.runs || []).map(r => [r.key, r]));
    pickSession(); statusPill(); await loadHistory();
    document.getElementById('conn').textContent = '已连接 · pi ' + (s.version || '');
  } catch (e) { document.getElementById('conn').textContent = String(e.message || e); }
}
async function loadHistory() {
  if (!current) { document.getElementById('feed').innerHTML = '<div class="empty">还没有会话</div>'; return; }
  try { const h = await api('/api/history?session=' + encodeURIComponent(current)); render(h.branch || []); }
  catch (e) { document.getElementById('feed').innerHTML = '<div class="empty">无法读取会话</div>'; }
}

function listen() {
  const es = new EventSource('/api/events?token=' + TOKEN);
  es.onopen = () => { document.getElementById('conn').textContent = '实时同步中'; };
  es.onerror = () => { es.close(); document.getElementById('conn').textContent = '连接断开，重试中…'; clearTimeout(reconnectTimer); reconnectTimer = setTimeout(listen, 3000); };
  es.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'run') { runs.set(msg.run.key, { ...runs.get(msg.run.key), ...lite(msg.run) }); statusPill(); }
    else if (msg.type === 'sessions-changed') loadState();
    else if (msg.type === 'rpc' && current && msg.key === current) {
      const t = msg.event && msg.event.type;
      if (t === 'message_end' || t === 'message_update' || t === 'agent_settled' || t === 'auto_retry_start') debouncedHistory();
    }
  };
}
function lite(r) { return { key: r.key, status: r.status, cwd: r.cwd, pending: r.pending, error: r.error }; }
let histTimer = null;
function debouncedHistory() { clearTimeout(histTimer); histTimer = setTimeout(loadHistory, 400); }

loadState(); listen();
</script>
</body>
</html>`;
}
