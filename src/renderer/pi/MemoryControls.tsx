import { useEffect, useId, useRef, useState } from 'react';
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

type MemoryBrowserProps = { cwd?: string; projects: SettingsSnapshot['projects']; globalDir?: string };

export function MemoryBrowser({ cwd, projects, globalDir }: MemoryBrowserProps) {
  // undefined follows the workspace; '' is an explicit global selection.
  // Derive during render so async cwd arrival never paints old rows under a new label.
  const [selectedProject, setSelectedProject] = useState<string>();
  const project = selectedProject ?? cwd ?? '';
  return <MemoryScopeBrowser key={project} cwd={cwd} projects={projects} globalDir={globalDir} project={project} onSelect={setSelectedProject} />;
}

/** Remount list/preview state on every scope change; cleanup fences pending reads. */
function MemoryScopeBrowser({ cwd, projects, globalDir, project, onSelect }: MemoryBrowserProps & { project: string; onSelect: (project: string) => void }) {
  const [apps, setApps] = useState<ExternalApp[]>([]);
  const [tool, setTool] = useState(() => { try { return localStorage.getItem('pi.memoryOpenApp') || 'finder'; } catch { return 'finder'; } });
  const [toolError, setToolError] = useState('');
  const [opening, setOpening] = useState(false);
  const openingRef = useRef(false);
  const [migrating, setMigrating] = useState(false);
  async function migrate(fn: () => Promise<unknown>, done: string) {
    if (migrating) return;
    setMigrating(true); setToolError('');
    try { await fn(); setRefresh(n => n + 1); } catch (e) { setToolError(`${done}失败：${message(e)}`); }
    finally { setMigrating(false); }
  }
  useEffect(() => {
    let alive = true;
    window.localPi.externalApps().then(list => { if (alive) setApps(list.filter(a => a.kind !== 'terminal')); }).catch(e => { if (alive) setToolError(message(e)); });
    return () => { alive = false; };
  }, []);
  const selectedTool = apps.find(a => a.id === tool) ?? apps[0];
  // 移到项目菜单：与文件名前缀匹配的项目排前面（如 litellm-*.md → litellm），仅作排序建议，用户确认后才移。
  const moveTargets = (name: string) => [...options].filter(([p]) => p !== project)
    .map(([p, n]) => ({ id: p, name: n, detail: p }))
    .sort((a, b) => (b.name.toLowerCase().startsWith(name.split('-')[0].toLowerCase()) ? 1 : 0) - (a.name.toLowerCase().startsWith(name.split('-')[0].toLowerCase()) ? 1 : 0));
  const movable = (f: MemoryFile) => !project && !f.rel.includes('/') && !['MEMORY.md', 'SCRATCHPAD.md'].includes(f.rel) && moveTargets(f.name).length > 0;
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
  const [preview, setPreview] = useState<{ rel: string; text?: string }>();
  const previewRegionId = useId();
  const previewTrigger = useRef<HTMLButtonElement>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const listId = useRef(0), previewId = useRef(0);
  function closePreview(restoreFocus = false) {
    previewId.current++;
    if (restoreFocus) previewTrigger.current?.focus();
    setPreview(undefined); setPreviewLoading(false); setPreviewError('');
  }
  function clear() {
    listId.current++;
    setFiles([]); setLoading(true); setError('');
    closePreview();
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
    // Own the disclosure immediately, including while the read is pending or fails.
    setPreview({ rel: file.rel }); setPreviewError(''); setPreviewLoading(true);
    try {
      const text = await window.localPi.memoryRead(file.rel, project || undefined);
      if (id === previewId.current) setPreview({ rel: file.rel, text });
    } catch (e) { if (id === previewId.current) setPreviewError(message(e)); }
    finally { if (id === previewId.current) setPreviewLoading(false); }
  }
  const options = new Map(projects.map(p => [p.path, p.name]));
  for (const p of [cwd, project]) if (p && !options.has(p)) options.set(p, p.split(/[\\/]/).filter(Boolean).at(-1) || p);
  const matchesQuery = (f: MemoryFile, value: string) => `${f.name} ${f.path}`.toLowerCase().includes(value.toLowerCase());
  const visible = files.filter(f => matchesQuery(f, query));
  function search(value: string) {
    setQuery(value);
    // A filtered-out row must not leave an orphan preview or resurrect on a late read.
    if (preview && !files.some(f => f.rel === preview.rel && matchesQuery(f, value))) closePreview();
  }
  const storageDir = project ? `${project.replace(/[\\/]+$/, '')}/.pi/memory` : globalDir;
  return <div>
    <p className="pi-memory__scope"><strong>当前浏览范围：{project ? `项目 · ${options.get(project)}` : '全局 · 共享'}</strong><br />存储目录：{storageDir ? <code>{storageDir}</code> : '正在确认全局存储路径…'}</p>
    <p>{project ? '项目本地记忆仅来自所选项目 .pi/memory（含子目录）；新自动摘要写入 .pi/memory/daily/YYYY-MM-DD.md。旧版 projects/ 映射会尽量标注所属项目（按历史路径识别）；识别不出的仍可能跨项目共用，不属于项目专属记忆。共享全局记忆请选择「全局记忆」。' : '显示共享全局记忆；旧版 projects/ 映射文件也会列出并尽量标注所属项目（按历史路径正向/反向识别，识别不出时标注未识别）。'} 浏览范围仅覆盖 agentDir/memory 与项目 .pi/memory，不代表所有第三方插件存储。第三方 memory 工具的检索与上下文注入范围由插件自行管理，不会因摘要路径改变而自动隔离。</p>
    {files.some(f => f.rel.startsWith('projects/')) && (() => {
      const migratable = files.filter(f => f.rel.startsWith('projects/') && f.projectPath);
      return <p>兼容性提示：projects/ 沿用旧版截断路径映射，已尽量标注归属项目；长路径前缀相同的项目可能共用同一文件。
        {migratable.length > 0 && <button type="button" className="pi-btn pi-btn--outline" style={{ marginLeft: 8 }} disabled={migrating}
          onClick={() => { if (window.confirm(`把 ${migratable.length} 个可识别归属的旧版记忆文件迁移到各项目 .pi/memory/legacy/？共用与未识别的会跳过。`)) void migrate(async () => {
            let moved = 0; const failed: string[] = [];
            for (const f of migratable) { try { await window.localPi.memoryMigrateLegacy(f.rel); moved += 1; } catch { failed.push(f.name); } }
            if (failed.length) throw new Error(`已迁移 ${moved} 个；失败 ${failed.length} 个：${failed.join('、')}`);
          }, '批量迁移'); }}>迁移全部可识别文件（{migratable.length}）</button>}
      </p>;
    })()}
    <div className="pi-memory__bar"><MemoryMenu label="记忆项目" title="工作区" selected={project} items={[{ id: '', name: '全局记忆' }, ...[...options].map(([path, name]) => ({ id: path, name, detail: `${path}${path === cwd ? '（当前工作区）' : ''}` }))]} onSelect={onSelect}><Icon name="folder" size={16} /><span>{options.get(project) || '全局记忆'}</span></MemoryMenu><strong className="pi-memory__count">{loading ? '正在加载…' : error ? '加载失败' : `${files.reduce((n, f) => n + f.entries, 0)} 条记忆 · ${files.length} 个文件`}</strong><input aria-label="搜索记忆文件" placeholder="搜索记忆文件…" value={query} onChange={e => search(e.target.value)} /><button type="button" className="pi-btn pi-btn--outline" onClick={() => { clear(); setRefresh(n => n + 1); }}>刷新记忆</button></div>
    {error && <p className="pi-features__alert" role="alert">无法读取记忆列表：{error}</p>}
    {toolError && <p className="pi-features__alert" role="alert">打开方式：{toolError}</p>}
    <ul className="pi-memory__list" aria-busy={loading}>
      {visible.map(f => {
        const expanded = preview?.rel === f.rel;
        const regionId = `${previewRegionId}-${encodeURIComponent(f.rel)}`;
        return <li key={f.path} className="pi-memory__row">
          <button ref={expanded ? previewTrigger : undefined} type="button" className="pi-memory__open" title={f.path} aria-expanded={expanded} aria-controls={expanded ? regionId : undefined} onClick={() => expanded ? closePreview() : void open(f)}>
            <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={14} />
            <span className="pi-memory__body"><strong>{f.name}</strong><small>{f.scope === 'global' ? f.rel.startsWith('projects/') ? (f.project ? `${f.project} · 旧版映射` : '旧版映射 · 未识别项目') : '全局 · 共享' : `${options.get(project) || '所选项目'} · 本地`} · {f.entries} 条 · {formatMemoryTime(f.updatedAt)}</small><small className="pi-memory__path">{f.path}</small></span>
          </button>
          <div className="pi-memory__tools">{movable(f) && <MemoryMenu label={`${f.name} 移到项目`} title="移到项目" selected="" items={moveTargets(f.name)} onSelect={id => { if (window.confirm(`把 ${f.name} 移动到「${options.get(id) || id}」的 .pi/memory/？原全局文件将移除。`)) void migrate(() => window.localPi.memoryMoveToProject(f.rel, id), '移动'); }}><span style={{ fontSize: 11 }}>移到项目</span></MemoryMenu>}{f.rel.startsWith('projects/') && f.projectPath && <button type="button" className="pi-memory__launch" style={{ width: 'auto', padding: '0 8px', fontSize: 11 }} title={`迁移到 ${f.project || f.projectPath} 的 .pi/memory/legacy/`}
            disabled={migrating} onClick={() => { if (window.confirm(`把 ${f.name} 迁移到「${f.project || f.projectPath}」项目的 .pi/memory/legacy/？原全局文件将移除。`)) void migrate(() => window.localPi.memoryMigrateLegacy(f.rel), '迁移'); }}>迁移到项目</button>}<button type="button" className="pi-memory__launch" aria-label={`用 ${selectedTool?.name || '文件管理器'} 打开 ${f.name}`} disabled={opening || !selectedTool} onClick={() => selectedTool && void openExternal(f, selectedTool.id)}>{appIcon(selectedTool)}</button><MemoryMenu label={`${f.name} 打开方式`} title="打开方式" selected={selectedTool?.id || ''} items={apps.map(app => ({ id: app.id, name: app.name, icon: appIcon(app) }))} onSelect={id => void openExternal(f, id)}><span className="pi-memory__sr">打开方式</span></MemoryMenu></div>
          {expanded && <div id={regionId} className="pi-memory__preview" role="region" aria-labelledby={`${regionId}-label`}>
            <div className="pi-memory__previewbar"><strong id={`${regionId}-label`}>预览：{f.rel}</strong><button type="button" className="pi-btn pi-btn--ghost" onClick={() => closePreview(true)}>关闭</button></div>
            {previewLoading && <p className="pi-memory__previewstatus" role="status">正在读取预览…</p>}
            {previewError && <div className="pi-memory__previewstatus"><p className="pi-features__alert" role="alert">无法读取预览：{previewError}</p><button type="button" className="pi-btn pi-btn--outline" onClick={() => void open(f)}>重试预览</button></div>}
            {preview.text !== undefined && <pre tabIndex={0} aria-label={`${f.name} 预览内容`}>{preview.text}</pre>}
          </div>}
        </li>;
      })}
      {!loading && !error && !visible.length && <li className="pi-memory__empty">{query ? '没有匹配的记忆文件。' : project ? '此项目暂无记忆文件。自动摘要保存后可点击「刷新记忆」查看；历史共享文件仍在「全局记忆」，不会自动迁移到项目。' : '暂无共享全局记忆。项目本地文件请在「记忆项目」中选择对应项目查看。'}</li>}
    </ul>
  </div>;
}
