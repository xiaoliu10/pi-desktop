const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
/** Minimal MCP client: stdio and Streamable HTTP. No credentials are logged. */
class McpClient {
  constructor(config, cwd, options = {}) { this.options = options; this.config = config; this.cwd = cwd; this.pending = new Map(); this.controllers = new Set(); this.closed = false; }
  async connect() {
    if (this.config.command) {
      this.child = spawn(this.config.command, this.config.args || [], { cwd: this.cwd, shell: false, detached: !!this.options.detached && process.platform !== 'win32', stdio: 'pipe', env: { ...process.env, ...this.config.env } });
      let buffer = ''; this.child.stdout.setEncoding('utf8');
      this.child.stdout.on('data', data => { buffer += data; if (Buffer.byteLength(buffer) > 8*1024*1024) { this.close(); return; } let at; while ((at=buffer.indexOf('\n'))>=0) { const line=buffer.slice(0,at);buffer=buffer.slice(at+1);try { this.receive(JSON.parse(line)); } catch {} } });
      this.child.stderr.on('data',()=>{});
      this.child.on('error',()=>this.close()); this.child.on('exit',()=>this.close()); this.child.stdin.on('error',()=>this.close());
    }
    const result = await this.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'pi-desktop', version: '0.1.0' } });
    this.protocol = result.protocolVersion;
    await this.notify('notifications/initialized');
    return this;
  }
  receive(message) {
    if (message.method && message.id !== undefined) { this.child?.stdin.write(JSON.stringify({jsonrpc:'2.0',id:message.id,...(message.method==='ping'?{result:{}}:{error:{code:-32601,message:'Unsupported server request'}})})+'\n');return; }
    const p=this.pending.get(message.id);if(!p)return;this.pending.delete(message.id);clearTimeout(p.timer);
    if(message.error)p.reject(new Error('MCP 请求失败：'+String(message.error.code)));else p.resolve(message.result);
  }
  async http(message, signal) {
    const controller=new AbortController();this.controllers.add(controller);
    const timer=setTimeout(()=>controller.abort(),message.method==='tools/call'?120000:30000);const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
    try {
      const headers={...this.config.headers,'Content-Type':'application/json',Accept:'application/json, text/event-stream',...(this.session?{'Mcp-Session-Id':this.session}:{}),...(this.protocol?{'MCP-Protocol-Version':this.protocol}:{})};
      const r=await fetch(this.config.url,{method:'POST',headers,body:JSON.stringify(message),signal:controller.signal,redirect:'error'});
      if(!r.ok)throw new Error('MCP HTTP '+r.status);this.session=r.headers.get('mcp-session-id')||this.session;
      if(message.id===undefined){await r.body?.cancel();return;}
      if(r.headers.get('content-type')?.includes('text/event-stream')) {
        const reader=r.body.getReader(),decoder=new TextDecoder();let buffer='',size=0;
        try { for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>8*1024*1024)throw new Error('MCP 响应过大');buffer+=decoder.decode(value,{stream:true}).replace(/\r\n/g,'\n');let at;while((at=buffer.indexOf('\n\n'))>=0){const block=buffer.slice(0,at);buffer=buffer.slice(at+2);const data=block.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');if(!data)continue;const parsed=JSON.parse(data);if(parsed.id===message.id)return parsed;}}throw new Error('MCP 响应中断'); } finally { await reader.cancel().catch(()=>{}); }
      }
      const text=await r.text();if(Buffer.byteLength(text)>8*1024*1024)throw new Error('MCP 响应过大');return JSON.parse(text);
    } finally { clearTimeout(timer);this.controllers.delete(controller);signal?.removeEventListener('abort',abort); }
  }
  async request(method, params={}, signal) {
    if(this.closed||signal?.aborted)throw new Error('MCP 连接已关闭或已取消');
    const id=randomUUID(),message={jsonrpc:'2.0',id,method,params};
    if(!this.child){const value=await this.http(message,signal);if(value.error)throw new Error('MCP 请求失败：'+value.error.code);return value.result;}
    return new Promise((resolve,reject)=>{
      const abort=()=>{this.pending.delete(id);clearTimeout(timer);reject(new Error('MCP 调用已取消'));void this.notify('notifications/cancelled',{requestId:id,reason:'User cancelled'}).catch(()=>{});};
      const timer=setTimeout(()=>{this.pending.delete(id);signal?.removeEventListener('abort',abort);reject(new Error('MCP 请求超时'));},method==='tools/call'?120000:15000);
      this.pending.set(id,{timer,resolve:v=>{signal?.removeEventListener('abort',abort);resolve(v);},reject:e=>{signal?.removeEventListener('abort',abort);reject(e);}});
      signal?.addEventListener('abort',abort,{once:true});this.child.stdin.write(JSON.stringify(message)+'\n');
    });
  }
  async notify(method, params={}) { if(this.closed)return;const msg={jsonrpc:'2.0',method,params};if(this.child)this.child.stdin.write(JSON.stringify(msg)+'\n');else await this.http(msg); }
  async tools() { const all=[];let cursor;for(let i=0;i<20;i++){const r=await this.request('tools/list',cursor?{cursor}:{});if(!Array.isArray(r.tools))throw new Error('MCP 工具列表格式无效');all.push(...r.tools);cursor=r.nextCursor;if(!cursor)return all;}throw new Error('MCP 分页超过上限'); }
  close(){if(this.closed)return;this.closed=true;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('MCP 连接已关闭'));}this.pending.clear();for(const c of this.controllers)c.abort();if(this.child){const kill=signal=>{try{if(this.options.detached&&process.platform!=='win32'&&this.child.pid)process.kill(-this.child.pid,signal);else if(this.child.exitCode===null)this.child.kill(signal);}catch{}};kill('SIGTERM');const t=setTimeout(()=>kill('SIGKILL'),1000);t.unref();} }
}
module.exports={McpClient};
