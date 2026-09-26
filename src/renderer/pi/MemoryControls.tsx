import { useEffect, useRef, useState } from 'react';
import { Icon } from '../replica/Icons';
import { MemoryMenu } from './MemoryMenu';
import type { ExternalApp } from '../../shared/open-with';
import type { SettingsSnapshot } from '../../shared/settings';

type MemoryFile = Awaited<ReturnType<typeof window.localPi.memoryList>>[number];
const message = (e: unknown) => e instanceof Error ? e.message : String(e);
function formatMemoryTime(mtimeMs: number, now = Date.now()): string {
  const diff = now - mtimeMs;
  if (diff < 60_000) return '刚刚';
  const d = new Date(mtimeMs);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (diff < 24 * 3600_000 && d.getDate() === new Date(now).getDate()) return `今天 ${hm}`;
  if (diff < 7 * 24 * 3600_000) return `${['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]} ${hm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** The preference is global; browsing a project never changes its scope. */
export function MemorySwitch({ enabled, disabled, onSaved, onSaving }: { enabled: boolean; disabled: boolean; onSaved: (enabled: boolean) => void; onSaving?: (saving: boolean) => void }) {
  const [pending, setPending] = useState<boolean>();
  const [error, setError] = useState('');
  const saving = useRef(false);
  async function toggle() {
    if (saving.current || disabled) return;
    saving.current = true;
    onSaving?.(true);
    const next = !enabled;
    setPending(next); setError('');
    try { await window.localPi.saveDesktopSettings({ memoryAssist: next }); onSaved(next); }
    catch (e) { setError(message(e)); }
    finally { saving.current = false; setPending(undefined); onSaving?.(false); }
  }
  return <>
    <div className="pi-memory__toggle"><div><strong id="memory-switch-label">工作区记忆</strong><p id="memory-switch-description">保存并复用长期上下文，新会话生效。此开关全局生效，不随项目独立设置。开启后可能增加推理调用和 Token 成本。</p></div>
      <button type="button" className="pi-memory__switch" role="switch" aria-labelledby="memory-switch-label" aria-describedby="memory-switch-description" aria-checked={pending ?? enabled} disabled={disabled || pending !== undefined} onClick={() => void toggle()}><span /></button>
    </div>
    {error && <p className="pi-features__alert" role="alert">保存失败，已恢复原设置：{error}</p>}
  </>;
}

export function MemoryBrowser({ cwd, projects }: { cwd?: string; projects: SettingsSnapshot['projects'] }) {
  const [project, setProject] = useState(cwd || '');
  const [apps, setApps] = useState<ExternalApp[]>([]);
  const [tool, setTool] = useState(() => { try { return localStorage.getItem('pi.memoryOpenApp') || 'finder'; } catch { return 'finder'; } });
  const [toolError, setToolError] = useState('');
  const [opening, setOpening] = useState(false);
  const openingRef = useRef(false);
  useEffect(() => {
    let alive = true;
    window.localPi.externalApps().then(list => { if (alive) setApps(list.filter(a => a.kind !== 'terminal')); }).catch(e => { if (alive) setToolError(message(e)); });
    return () => { alive = false; };
  }, []);
  const selectedTool = apps.find(a => a.id === tool) ?? apps[0];
  const appIcon = (app?: ExternalApp) => app?.icon ? <img src={app.icon} alt="" width={16} height={16} /> : <Icon name={app?.kind === 'editor' ? 'code' : 'folder'} size={16} />;
  async function openExternal(file: MemoryFile, appId: string) {
    if (openingRef.current) return;
    openingRef.current = true; setOpening(true); setToolError('');
    setTool(appId);
    try { localStorage.setItem('pi.memoryOpenApp', appId); } catch { /* optional preference */ }
    try { await window.localPi.memoryOpen(file.rel, project || undefined, appId); }
    catch (e) { setToolError(message(e)); }
    finally { openingRef.current = false; setOpening(false); }
  }
  const [query, setQuery] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [files, setFiles] = useState<MemoryFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<{ rel: string; text: string }>();
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const listId = useRef(0), previewId = useRef(0);
  function clear() {
    listId.current++; previewId.current++;
    setFiles([]); setLoading(true); setError('');
    setPreview(undefined); setPreviewLoading(false); setPreviewError('');
  }
  useEffect(() => {
    const id = ++listId.current;
    window.localPi.memoryList(project || undefined).then(value => {
      if (id === listId.current) setFiles(value);
    }).catch(e => { if (id === listId.current) setError(message(e)); })
      .finally(() => { if (id === listId.current) setLoading(false); });
    return () => { listId.current++; previewId.current++; };
  }, [project, refresh]);
  async function open(file: MemoryFile) {
    const id = ++previewId.current;
    setPreview(undefined); setPreviewError(''); setPreviewLoading(true);
    try {
      const text = await window.localPi.memoryRead(file.rel, project || undefined);
      if (id === previewId.current) setPreview({ rel: file.rel, text });
    } catch (e) { if (id === previewId.current) setPreviewError(message(e)); }
    finally { if (id === previewId.current) setPreviewLoading(false); }
  }
  const options = new Map(projects.map(p => [p.path, p.name]));
  for (const p of [cwd, project]) if (p && !options.has(p)) options.set(p, p.split(/[\\/]/).filter(Boolean).at(-1) || p);
  const visible = files.filter(f => `${f.name} ${f.path}`.toLowerCase().includes(query.toLowerCase()));
  return <div>
    <p>{project ? '显示所选项目与共享的全局记忆，来源已逐项标明；全局文件可能包含其他项目上下文，并非严格隔离。' : '仅显示共享全局记忆，不包含 projects/ 下的项目文件。'} 浏览范围仅覆盖 agentDir/memory 与项目 .pi/memory，不代表所有第三方插件存储。</p>
    {files.some(f => f.rel.startsWith('projects/')) && <p>旧版 projects/ 文件按截断路径匹配，长路径前缀相同的项目可能共用同一文件。</p>}
    <div className="pi-memory__bar"><MemoryMenu label="记忆项目" title="工作区" selected={project} items={[{ id: '', name: '全局记忆' }, ...[...options].map(([path, name]) => ({ id: path, name, detail: `${path}${path === cwd ? '（当前工作区）' : ''}` }))]} onSelect={id => { if (id !== project) { clear(); setProject(id); } }}><Icon name="folder" size={16} /><span>{options.get(project) || '全局记忆'}</span></MemoryMenu><strong className="pi-memory__count">{loading ? '正在加载…' : error ? '加载失败' : `${files.reduce((n, f) => n + f.entries, 0)} 条记忆`}</strong><input aria-label="搜索记忆文件" placeholder="搜索记忆文件…" value={query} onChange={e => setQuery(e.target.value)} /><button type="button" className="pi-btn pi-btn--outline" onClick={() => { clear(); setRefresh(n => n + 1); }}>刷新记忆</button></div>
    {error && <p className="pi-features__alert" role="alert">无法读取记忆列表：{error}</p>}
    {toolError && <p className="pi-features__alert" role="alert">打开方式：{toolError}</p>}
    <ul className="pi-memory__list" aria-busy={loading}>
      {visible.map(f => <li key={f.path} className="pi-memory__row"><button type="button" className="pi-memory__open" title={f.path} onClick={() => void open(f)}><span className="pi-memory__body"><strong>{f.name}</strong><small>{f.scope === 'global' ? '全局 · 共享' : f.rel.startsWith('projects/') ? '项目路径匹配 · 旧版映射' : '所选项目'} · {f.entries} 条 · {formatMemoryTime(f.updatedAt)}</small></span></button><div className="pi-memory__tools"><button type="button" className="pi-memory__launch" aria-label={`用 ${selectedTool?.name || '文件管理器'} 打开 ${f.name}`} disabled={opening || !selectedTool} onClick={() => selectedTool && void openExternal(f, selectedTool.id)}>{appIcon(selectedTool)}</button><MemoryMenu label={`${f.name} 打开方式`} title="打开方式" selected={selectedTool?.id || ''} items={apps.map(app => ({ id: app.id, name: app.name, icon: appIcon(app) }))} onSelect={id => void openExternal(f, id)}><span className="pi-memory__sr">打开方式</span></MemoryMenu></div></li>)}
      {!loading && !error && !visible.length && <li className="pi-memory__empty">{query ? '没有匹配的记忆文件。' : '此范围暂无记忆文件。'}</li>}
    </ul>
    {previewLoading && <p role="status">正在读取预览…</p>}
    {previewError && <p className="pi-features__alert" role="alert">无法读取预览：{previewError}</p>}
    {preview && <div className="pi-memory__preview"><div className="pi-memory__previewbar"><strong>{preview.rel}</strong><button type="button" className="pi-btn pi-btn--ghost" onClick={() => { previewId.current++; setPreview(undefined); }}>关闭</button></div><pre>{preview.text}</pre></div>}
  </div>;
}
