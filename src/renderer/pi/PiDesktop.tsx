import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { LocalPiApi, PiEnvironment, PiEntry, PiEvent, PiHistory, PiResource, PiReview, PiRun, PiSession, PiUiRequest } from '../../shared/pi';
import './pi-desktop.css';
declare global { interface Window { localPi: LocalPiApi } }
const clean = (value: unknown) => String(value ?? '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '');
const textContent = (content: unknown): string => typeof content === 'string' ? content : Array.isArray(content) ? content.filter(b => b?.type === 'text').map(b => b.text).join('\n') : '';
function Message({ message }: { message: Record<string, any> }) {
  const text = clean(textContent(message.content));
  return <article className={`native-message ${message.role === 'user' ? 'native-user' : ''}`}>
    <div className="native-message-label">{message.role === 'user' ? '你' : message.role === 'toolResult' ? `工具结果 · ${message.toolName || ''}` : message.role === 'assistant' ? 'pi' : message.role || '记录'}</div>
    {message.role === 'toolResult' ? <details><summary className={message.isError ? 'native-error-text' : ''}>{message.isError ? '执行失败' : '查看输出'}</summary><pre>{text || '(无文本输出)'}</pre></details> : text && <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>}
    {Array.isArray(message.content) && message.content.filter((b: any) => b.type === 'toolCall').map((b: any, i: number) => <details className="native-tool" key={b.id || i}><summary>⌘ {b.name}</summary><pre>{JSON.stringify(b.arguments, null, 2)}</pre></details>)}
    {Array.isArray(message.content) && message.content.filter((b: any) => b.type === 'thinking').map((b: any, i: number) => <details key={i}><summary>思考记录</summary><pre>{clean(b.thinking)}</pre></details>)}
    {Array.isArray(message.content) && message.content.some((b: any) => b.type === 'image') && <small>此消息包含图片；当前历史视图仅展示文本。</small>}
    {message.errorMessage && <p className="native-error-text">{clean(message.errorMessage)}</p>}
  </article>;
}
function HistoryEntry({ entry }: { entry: PiEntry }) {
  if (entry.type === 'message' && entry.message) return <Message message={entry.message} />;
  if (['compaction', 'branch_summary'].includes(entry.type)) return <details className="native-record"><summary>{entry.type === 'compaction' ? '上下文压缩' : '分支摘要'}</summary><pre>{clean(entry.summary)}</pre></details>;
  if (['custom', 'custom_message'].includes(entry.type)) return <details className="native-record"><summary>扩展记录 · {String(entry.customType || entry.type)}</summary><pre>{JSON.stringify(entry.data || entry, null, 2)}</pre></details>;
  return null;
}
type Dialog = { key: string; generation: string; request: PiUiRequest };
function ExtensionDialog({ dialog, answer }: { dialog: Dialog; answer: (value: { id: string; value?: string; confirmed?: boolean; cancelled?: boolean }) => void }) {
  const r = dialog.request;
  const [value, setValue] = useState(String(r.prefill || ''));
  useEffect(() => { const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') answer({ id: r.id, cancelled: true }); }; window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler); }, [r.id, answer]);
  return <div className="native-backdrop"><section className="native-modal" role="dialog" aria-modal="true" aria-label={r.title || 'pi 扩展交互'}>
    <small>pi 扩展请求</small><h2>{clean(r.title || '需要你的回答')}</h2>{r.message && <pre>{clean(r.message)}</pre>}
    {r.method === 'select' ? <div className="native-options">{r.options?.map((option, i) => <button autoFocus={i === 0} key={option} onClick={() => answer({ id: r.id, value: option })}>{clean(option)}</button>)}</div> : r.method === 'editor' ? <textarea autoFocus rows={8} value={value} onChange={e => setValue(e.target.value)} /> : r.method === 'input' ? <input autoFocus placeholder={r.placeholder} value={value} onChange={e => setValue(e.target.value)} /> : null}
    <footer><button onClick={() => answer({ id: r.id, cancelled: true })}>取消 / 拒绝</button>{r.method !== 'select' && <button className="primary" onClick={() => answer(r.method === 'confirm' ? { id: r.id, confirmed: true } : { id: r.id, value })}>{r.method === 'confirm' ? '允许本次' : '确定'}</button>}</footer>
  </section></div>;
}
export default function PiDesktop() {
  const api = window.localPi;
  const [env, setEnv] = useState<PiEnvironment>();
  const [sessions, setSessions] = useState<PiSession[]>([]), [runs, setRuns] = useState<PiRun[]>([]);
  const [selected, setSelected] = useState(''), [history, setHistory] = useState<PiHistory>();
  const [page, setPage] = useState<'chat' | 'resources' | 'settings'>('chat');
  const [search, setSearch] = useState(''), [text, setText] = useState(''), [behavior, setBehavior] = useState<'steer' | 'followUp'>('followUp');
  const [resources, setResources] = useState<PiResource[]>([]), [review, setReview] = useState<PiReview>();
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const [dialogs, setDialogs] = useState<Dialog[]>([]);
  const drafts = useRef<Record<string, string>>({});
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [toolProgress, setToolProgress] = useState<Record<string, Record<string, { name: string; text: string }>>>({});
  const [widgets, setWidgets] = useState<Record<string, Record<string, string>>>({});
  const [live, setLive] = useState<Record<string, Record<string, Record<string, any>>>>({});
  const [draft, setDraft] = useState<{ sourceKey?: string; cwd?: string }>();
  const [trust, setTrust] = useState(false), [fullAccess, setFullAccess] = useState(false);
  const [paths, setPaths] = useState({ executable: '', agentDir: '', sessionDirs: '' });
  const [leaf, setLeaf] = useState<string>();
  const selectedRef = useRef(''), leafRef = useRef<string>(), loadSeq = useRef(0), mounted = useRef(true);
  const scroll = useRef<HTMLDivElement>(null);
  const currentRun = runs.find(r => r.key === selected);
  const currentSession = sessions.find(s => s.key === selected);
  const cwd = currentRun?.cwd || currentSession?.cwd;
  const attempt = async (fn: () => Promise<unknown>) => { setError(''); try { return await fn(); } catch (e) { setError(String((e as Error).message || e)); return undefined; } };
  const refreshHistory = useCallback(async () => {
    const key = selectedRef.current, seq = ++loadSeq.current;
    if (!key) return;
    try {
      const value = await api.history(key, leafRef.current);
      if (!mounted.current || seq !== loadSeq.current || key !== selectedRef.current) return;
      setHistory(value);
      const persisted = new Set(value.branch.filter(e => e.message).map(e => String(e.message!.timestamp)));
      setLive(prev => ({ ...prev, [key]: Object.fromEntries(Object.entries(prev[key] || {}).filter(([id]) => !persisted.has(id))) }));
    } catch { if (mounted.current && seq === loadSeq.current) setHistory(undefined); }
  }, [api]);
  const select = (key: string) => { drafts.current[selectedRef.current] = text; setText(drafts.current[key] || ''); selectedRef.current = key; leafRef.current = undefined; setSelected(key); setLeaf(undefined); setHistory(undefined); setReview(undefined); setPage('chat'); void refreshHistory(); };
  useEffect(() => {
    if (!api) return;
    mounted.current = true;
    let alive = true;
    const reload = async () => { try { const list = await api.sessions(); if (alive) setSessions(list); } catch (e) { if (alive) setError(String(e)); } };
    const listener = (event: PiEvent) => {
      if (!alive) return;
      if (event.type === 'sessions-changed') { void reload(); void refreshHistory(); }
      if (event.type === 'resources-changed') setNotice('本地 pi 资源有变化。空闲时点击“重载扩展”使运行中的会话重新加载。');
      if (event.type === 'run') { setRuns(prev => [...prev.filter(r => r.key !== event.run.key), event.run]); if (event.run.error) setError(event.run.error); }
      if (event.type === 'closed') {
        setRuns(prev => prev.filter(r => !(r.key === event.key && r.generation === event.generation)));
        setDialogs(prev => prev.filter(d => d.generation !== event.generation));
        setWidgets(prev => { const next = { ...prev }; delete next[event.key]; return next; });
        setLive(prev => { const next = { ...prev }; delete next[event.key]; return next; });
      }
      if (event.type === 'ui') {
        const r = event.request;
        if (['select', 'confirm', 'input', 'editor'].includes(r.method)) setDialogs(prev => [...prev.filter(d => !(d.key === event.key && d.generation === event.generation && d.request.id === r.id)), { key: event.key, generation: event.generation, request: r }]);
        else if (r.method === 'notify') setNotice(clean(r.message));
        else if (r.method === 'set_editor_text') { drafts.current[event.key] = String(r.text || ''); if (selectedRef.current === event.key) setText(drafts.current[event.key]); }
        else if (r.method === 'setTitle') setTitles(prev => ({ ...prev, [event.key]: clean(r.title) }));
        else if (r.method === 'setStatus' || r.method === 'setWidget') {
          const id = String(r.statusKey || r.widgetKey);
          const value = r.method === 'setStatus' ? clean(r.statusText) : Array.isArray(r.widgetLines) ? r.widgetLines.map(clean).join('\n') : '';
          setWidgets(prev => { const next = { ...(prev[event.key] || {}) }; if (value) next[id] = value; else delete next[id]; return { ...prev, [event.key]: next }; });
        }
      }
      if (event.type === 'rpc') {
        const e = event.event as Record<string, any>;
        if (['tool_execution_start', 'tool_execution_update', 'tool_execution_end'].includes(e.type)) setToolProgress(prev => ({ ...prev, [event.key]: { ...prev[event.key], [e.toolCallId]: { name: String(e.toolName || '工具'), text: clean(textContent((e.partialResult || e.result)?.content) || (e.type === 'tool_execution_start' ? JSON.stringify(e.args) : '执行完成')) } } }));
        if (e.type === 'agent_settled') setToolProgress(prev => ({ ...prev, [event.key]: {} }));
        if (e.type === 'auto_retry_start') setNotice('pi 正在自动重试，当前任务尚未完成。');
        if (e.type === 'compaction_start') setNotice('pi 正在压缩上下文…');
        if (['message_update', 'message_end'].includes(e.type) && e.message?.role === 'assistant') {
          const id = String(e.message.timestamp || 'stream');
          setLive(prev => ({ ...prev, [event.key]: { ...prev[event.key], [id]: e.message } }));
        }
        if (e.type === 'message_end' || e.type === 'agent_settled') { void reload(); void refreshHistory(); }
        if (e.type === 'extension_error') setError(`扩展错误：${clean(e.error || e.message)}`);
        if (e.type === 'ui-expired') setDialogs(prev => prev.filter(d => !(d.key === event.key && d.generation === event.generation && d.request.id === e.id)));
      }
    };
    const off = api.onEvent(listener);
    void Promise.all([api.environment(), api.sessions(), api.runs()]).then(([environment, list, active]) => {
      if (!alive) return;
      setEnv(environment); setSessions(list); setRuns(active);
      setPaths({ executable: environment.executable || '', agentDir: environment.agentDir, sessionDirs: environment.sessionDirs.join('\n') });
      if (!selectedRef.current && list.length) { selectedRef.current = list[0].key; setSelected(list[0].key); void refreshHistory(); }
    }).catch(e => { if (alive) setError(String(e)); });
    return () => { alive = false; mounted.current = false; off(); };
  }, [api, refreshHistory]);
  useEffect(() => { if (page === 'resources' && api) void api.resources(cwd).then(setResources).catch(e => setError(String(e))); }, [page, cwd, runs, api]);
  const answer = async (response: { id: string; value?: string; confirmed?: boolean; cancelled?: boolean }) => {
    const d = dialogs[0]?.request.id === response.id ? dialogs[0] : undefined; if (!d) return;
    setDialogs(prev => prev.filter(x => x !== d));
    await attempt(() => api.respond(d.key, d.generation, response));
  };
  const connect = async () => {
    if (!draft) return; setBusy(true);
    const value = await attempt(() => api.connect({ ...draft, trustProject: trust, permission: fullAccess ? 'fullAccess' : 'ask' }));
    setBusy(false);
    if (value) { const run = value as PiRun; setRuns(prev => [...prev.filter(r => r.key !== run.key), run]); setDraft(undefined); select(run.key); setNotice('已连接本地 pi。已有 CLI 会话的原文件保持不变；桌面副本也保存在 pi 会话目录中。'); }
  };
  const send = async () => {
    if (!currentRun || !text.trim()) return;
    const value = text; setText('');
    try { await api.prompt(currentRun.key, value, behavior); } catch (e) { setText(value); setError(String(e)); }
  };
  if (!api) return <div className="native-app native-unavailable">请使用 <code>pnpm build && pnpm start</code> 打开桌面应用。此页面不会使用假数据替代本地 pi。</div>;
  const groups = [...new Set(sessions.filter(s => `${s.name} ${s.cwd}`.toLowerCase().includes(search.toLowerCase())).map(s => s.cwd))];
  return <div className="native-app" data-pi-ready={env ? 'true' : undefined}>
    <aside className="native-sidebar">
      <div className="native-brand"><b>π</b><span>PI Desktop<small>本地 pi 工作台</small></span></div>
      <button className="primary" disabled={!env?.supported} onClick={() => void attempt(async () => { const dir = await api.pickDirectory(); if (dir) { setTrust(false); setFullAccess(false); setDraft({ cwd: dir }); } })}>＋ 新建 pi 会话</button>
      <input aria-label="搜索会话" placeholder="搜索 CLI 与桌面会话…" value={search} onChange={e => setSearch(e.target.value)} />
      <div className="native-session-list">{groups.map(group => <section key={group}><h3 title={group}>⌄ {group.split(/[\\/]/).filter(Boolean).at(-1) || group}</h3>{sessions.filter(s => s.cwd === group && `${s.name} ${s.cwd}`.toLowerCase().includes(search.toLowerCase())).map(s => <button title={`${s.cwd}\n${s.path}`} className={`native-session ${selected === s.key ? 'selected' : ''}`} key={s.key} onClick={() => select(s.key)}><span>{s.name}</span><small>{s.owned ? 'Desktop' : 'pi CLI'} · {new Date(s.updatedAt).toLocaleDateString()}</small></button>)}</section>)}{!sessions.length && <p className="native-muted">未发现会话。可在连接设置中添加其他 pi 会话目录。</p>}{sessions.length > 0 && !groups.length && <p className="native-muted">没有匹配的会话</p>}</div>
      {runs.filter(r => !sessions.some(s => s.key === r.key)).map(r => <button key={r.key} onClick={() => select(r.key)}>◉ 新桌面会话 · {r.status}</button>)}
      <nav><button className={page === 'resources' ? 'selected' : ''} onClick={() => setPage('resources')}>⌘ 插件与资源</button><button className={page === 'settings' ? 'selected' : ''} onClick={() => setPage('settings')}>⚙ 连接设置</button></nav>
      <small className="native-muted">pi {env?.version || '未发现'} · {sessions.length} 个会话</small>
    </aside>
    <main className="native-main">
      <header className="native-header"><div><strong>{page === 'resources' ? '插件与资源' : page === 'settings' ? '本地 pi 连接' : titles[selected] || currentSession?.name || '开始与本地 pi 协作'}</strong><small>{page === 'chat' ? cwd || 'CLI 会话自动发现，无需导入' : env?.agentDir}</small></div><button onClick={() => { setPage('chat'); void refreshHistory(); }}>会话</button>{cwd && <button onClick={() => void attempt(async () => setReview(await api.review(cwd)))}>Review</button>}</header>
      {error && <div role="alert" className="native-banner error">{error}<button aria-label="关闭错误" onClick={() => setError('')}>×</button></div>}
      {notice && <div role="status" className="native-banner">{notice}<button aria-label="关闭提示" onClick={() => setNotice('')}>×</button></div>}
      <div className="native-body">
        {page === 'settings' ? <section className="native-page"><h1>直接连接你的 pi</h1><p>共享原生配置和会话。此处仅保存 Desktop 的路径设置，不复制认证，也不修改 pi 配置。</p>{env?.diagnostics.map(d => <p className="native-warning" key={d}>{d}</p>)}<label>pi 可执行路径<input value={paths.executable} onChange={e => setPaths({ ...paths, executable: e.target.value })} /></label><label>pi 配置目录<input value={paths.agentDir} onChange={e => setPaths({ ...paths, agentDir: e.target.value })} /></label><label>额外会话目录（每行一个）<textarea rows={4} value={paths.sessionDirs} onChange={e => setPaths({ ...paths, sessionDirs: e.target.value })} /></label><button className="primary" disabled={runs.length > 0} onClick={() => void attempt(async () => { const next = await api.configure({ ...paths, sessionDirs: paths.sessionDirs.split('\n').map(s => s.trim()).filter(Boolean) }); setEnv(next); setSessions(await api.sessions()); setNotice('连接配置已保存。'); })}>保存连接设置</button>{runs.length > 0 && <p>修改前请先断开下方会话。</p>}<h2>桌面连接</h2>{runs.map(r => <div className="native-resource" key={r.key}><span>{r.cwd}<small>{r.status} · {r.key.slice(0, 10)}</small></span><button onClick={() => void attempt(() => api.close(r.key))}>断开</button></div>)}<h2>能力范围</h2><p>已在 macOS 验证 pi 0.85.1；Linux 尚待实机验证。只读查看不会启动代理；执行会加载你信任的全局扩展。工具确认无法限制扩展直接调用 Node 的行为。认证设置请在 pi CLI 完成。</p></section>
        : page === 'resources' ? <section className="native-page"><div className="native-page-title"><h1>本地插件与资源</h1><button onClick={() => void attempt(async () => setResources(await api.resources(cwd)))}>重新扫描</button></div><p>直接读取本地 pi 资源，无需再次安装。已发现不等于已加载；仅通过 RPC 注册的命令标记为可调用。</p>{cwd && <small>项目：{cwd}</small>}<input placeholder="当前会话的 / 命令可在输入框直接调用" disabled />{resources.length === 0 ? <p>未发现资源。使用终端 pi install 后重新扫描。</p> : resources.map(r => <details className="native-resource-detail" key={r.id}><summary><span><strong>{r.name}</strong><small>{r.kind} · {r.scope === 'user' ? '全局' : '项目'}</small></span><span className={`native-tag ${r.status}`}>{({ discovered: '已发现 · 加载未确认', callable: '命令可调用', disabled: '已排除', missing: '路径缺失', error: '读取失败' })[r.status]}</span></summary><p>{r.detail}</p><code>{r.path}</code></details>)}<p className="native-muted">自定义终端组件、主题和快捷键不自动变成桌面 UI。需要重新加载时，在空闲的会话中点击“重载扩展”。</p></section>
        : <section className="native-chat">
          <div className="native-session-toolbar"><span className="native-tag">{currentRun ? `Desktop · ${currentRun.status}${currentRun.pending ? ` · 排队 ${currentRun.pending}` : ''}` : '只读观察'}</span>{history && <small>最近同步 {new Date(history.syncedAt).toLocaleTimeString()}</small>}{history && history.leaves.length > 1 && <select aria-label="历史分支" value={leaf || history.leafId || ''} onChange={e => { leafRef.current = e.target.value; setLeaf(e.target.value); void refreshHistory(); }}>{history.leaves.map(id => <option key={id} value={id}>历史分支 {id.slice(0, 8)}</option>)}</select>}<span className="native-flex" />{currentRun ? <><button disabled={currentRun.status !== 'idle'} onClick={() => void attempt(() => api.refresh(currentRun.key))}>重载扩展</button><button onClick={() => void attempt(() => api.close(currentRun.key))}>断开</button></> : currentSession && <button className="primary" disabled={!env?.supported} onClick={() => { setDraft({ sourceKey: currentSession.key }); setTrust(false); setFullAccess(false); }}>在 Desktop 接续副本</button>}</div>
          {history?.session.warnings.map(w => <div className="native-warning" key={w}>{w}</div>)}
          <div className="native-transcript" ref={scroll}>{history?.branch.map((e, i) => <HistoryEntry key={e.id || i} entry={e} />)}{Object.entries(live[selected] || {}).map(([id, m]) => <Message key={id} message={m} />)}{!history?.branch.length && !Object.keys(live[selected] || {}).length && <div className="native-welcome"><div>π</div><h1>{currentRun ? '会话已连接' : '你的终端会话，就在这里'}</h1><p>{currentRun ? '选择模型，或通过 / 调用已加载的扩展命令。' : '选择左侧会话查看历史。CLI 新建和保存的记录会自动同步。'}</p><small>已保存历史同步 · 不冒充终端实时逐字输出</small></div>}</div>
          {Object.entries(toolProgress[selected] || {}).map(([id, progress]) => <details className="native-widget" key={id}><summary>工具进度 · {progress.name}</summary><pre>{progress.text}</pre></details>)}
          {Object.entries(widgets[selected] || {}).map(([key, value]) => <pre className="native-widget" key={key}>{value}</pre>)}
          {currentRun ? <div className="native-composer"><textarea aria-label="发送给 pi" value={text} onChange={e => setText(e.target.value)} placeholder="描述任务，或输入 /plan、/todos 等扩展命令…" onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} />{text.startsWith('/') && <div className="native-command-list">{currentRun.commands.filter(c => c.name.startsWith(text.slice(1))).slice(0, 8).map(c => <button key={c.name} onClick={() => setText('/' + c.name + ' ')}>/{c.name} <small>{c.description}</small></button>)}</div>}<footer><select aria-label="模型" value={currentRun.model ? `${currentRun.model.provider}/${currentRun.model.id}` : ''} disabled={currentRun.status !== 'idle'} onChange={e => { const m = currentRun.models.find(m => `${m.provider}/${m.id}` === e.target.value); if (m) void attempt(() => api.model(currentRun.key, m.provider, m.id)); }}><option value="" disabled>选择 pi 模型</option>{currentRun.models.map(m => <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>{m.name} · {m.provider}</option>)}</select><select aria-label="运行中输入策略" value={behavior} onChange={e => setBehavior(e.target.value as typeof behavior)}><option value="followUp">排队追问</option><option value="steer">调整当前任务</option></select><span className="native-flex" />{currentRun.status !== 'idle' && <button onClick={() => void attempt(async () => { const queue = await api.stop(currentRun.key); setText([...queue.steering, ...queue.followUp].join('\n')); setNotice('已停止；未执行的排队输入已恢复。'); })}>停止</button>}<button className="primary" disabled={!text.trim() || !['idle', 'running'].includes(currentRun.status)} onClick={() => void send()}>发送 ↑</button></footer></div> : <div className="native-readonly">只读查看原始 pi 会话。要发送消息，请创建桌面接续副本；原 CLI 会话保持不变。</div>}
        </section>}
        {review && <aside className="native-review"><header><strong>工作区 Review</strong><button aria-label="关闭 Review" onClick={() => setReview(undefined)}>×</button></header><p>{review.warning}</p><pre>{review.diff || '没有已跟踪文件的净变化。'}</pre><h3>未跟踪文件</h3>{review.untracked.map(p => <code key={p}>{p}</code>)}</aside>}
      </div>
    </main>
    {draft && <div className="native-backdrop"><section className="native-modal" role="dialog" aria-modal="true" aria-label="连接本地 pi"><h2>{draft.sourceKey ? '创建桌面接续副本' : '新建 pi 会话'}</h2><p>使用本机 pi、原生模型配置和全局扩展。{draft.sourceKey && '将从文件的最新分支接续，原始 CLI 会话不会被 Desktop 写入。'}</p><label className="native-checkbox"><input type="checkbox" checked={trust} onChange={e => setTrust(e.target.checked)} />本次信任项目的 .pi 配置和扩展</label><label className="native-checkbox"><input type="checkbox" checked={fullAccess} onChange={e => setFullAccess(e.target.checked)} />允许所有工具调用（默认逐次确认）</label><p className="native-muted">扩展是你信任的本地代码。工具确认不等于操作系统沙箱。</p><footer><button disabled={busy} onClick={() => setDraft(undefined)}>取消</button><button className="primary" disabled={busy} onClick={() => void connect()}>{busy ? '正在连接…' : '连接 pi'}</button></footer></section></div>}
    {dialogs[0] && <ExtensionDialog key={dialogs[0].generation + dialogs[0].request.id} dialog={dialogs[0]} answer={answer} />}
  </div>;
}
