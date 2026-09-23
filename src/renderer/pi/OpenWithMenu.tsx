import { useEffect, useRef, useState } from 'react';
import { Icon } from '../replica/Icons';
import type { ExternalApp } from '../../shared/open-with';
import { usePiStore } from './adapter';

/**
 * 顶栏「打开方式」分割按钮：主按钮用已选应用打开当前项目目录（默认 Finder），
 * 下拉选择其他已安装应用并记住偏好（勾选标记）。Escape / 外部点击关闭，
 * 无 cwd 时主按钮禁用。错误显示在下拉面板内（role="alert"）。
 */
export function OpenWithMenu({ cwd, lang }: { cwd?: string; lang: 'en' | 'zh' }) {
  const zh = lang === 'zh';
  const saved = usePiStore(s => s.desktopPreferences?.openWithApp);
  const [apps, setApps] = useState<ExternalApp[] | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let alive = true;
    window.localPi!.externalApps()
      .then(list => { if (alive) setApps(list); })
      .catch(e => { if (alive) { setApps([]); setLoadError((e as Error).message); } });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!open) return;
    const click = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener('mousedown', click);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', click); document.removeEventListener('keydown', key); };
  }, [open, busy]);

  const selected = (apps ?? []).find(a => a.id === saved) ?? apps?.[0];
  const appName = (app: ExternalApp) => (app.id === 'file-manager' ? (zh ? '文件管理器' : 'File Manager') : app.name);

  // 以根容器右下角对齐定位菜单（caret 与主按钮同在一行，右缘一致）。
  const placeMenu = () => {
    const rect = root.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition({ left: Math.max(8, rect.right - 230), top: Math.max(8, Math.min(window.innerHeight - 280, rect.bottom + 4)) });
  };

  const openCwd = async (appId?: string) => {
    if (!cwd || !appId || busy) return;
    setBusy(true); setError('');
    try { await window.localPi!.openWith(cwd, appId); setOpen(false); }
    catch (e) { placeMenu(); setError((e as Error).message); setOpen(true); }
    finally { setBusy(false); }
  };

  const choose = async (id: string) => {
    setError(''); setOpen(false); trigger.current?.focus();
    try {
      await window.localPi!.saveDesktopSettings({ openWithApp: id });
      const snapshot = await window.localPi!.settingsSnapshot();
      usePiStore.setState({ desktopPreferences: snapshot.preferences });
    } catch (e) { placeMenu(); setError((e as Error).message); setOpen(true); }
  };

  const openLabel = selected
    ? zh ? `用 ${appName(selected)} 打开当前项目` : `Open current project in ${appName(selected)}`
    : zh ? '打开当前项目' : 'Open current project';
  return (
    <div className="pi-openwith" ref={root}>
      <div className="pi-openwith__split">
        <button
          className="pi-openwith__main"
          disabled={!cwd || busy || !selected}
          aria-label={openLabel}
          title={cwd ? openLabel : zh ? '没有可打开的项目目录' : 'No project folder to open'}
          onClick={() => void openCwd(selected?.id)}
        >
          {selected?.icon ? <img src={selected.icon} alt="" width={16} height={16} /> : <Icon name={selected?.kind === 'terminal' ? 'terminal' : selected?.kind === 'editor' ? 'code' : 'folder'} size={15} />}
          <span>{selected ? appName(selected) : '…'}</span>
        </button>
        <button
          ref={trigger}
          className="pi-openwith__caret"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={zh ? '选择打开方式' : 'Choose app to open with'}
          title={zh ? '选择打开方式' : 'Choose app to open with'}
          onClick={() => {
            placeMenu();
            setOpen(v => !v); setError('');
          }}
        >
          <Icon name="chevron-down" size={13} />
        </button>
      </div>
      {open && (
        <div className="pi-project-menu pi-openwith__menu" style={position} role="menu" aria-label={zh ? '打开方式' : 'Open with'}>
          {loadError && <p role="alert">{loadError}</p>}
          {error && !loadError && <p role="alert">{error}</p>}
          {(apps ?? []).map(app => (
            <button key={app.id} role="menuitemradio" aria-checked={app.id === selected?.id} autoFocus={app.id === selected?.id} onClick={() => void choose(app.id)}>
              {app.icon ? <img src={app.icon} alt="" width={16} height={16} /> : <Icon name={app.kind === 'terminal' ? 'terminal' : app.kind === 'editor' ? 'code' : 'folder'} size={15} />}
              <span>{appName(app)}</span>
              {app.id === selected?.id && <small><Icon name="check" size={14} /></small>}
            </button>
          ))}
          {apps && apps.length === 0 && !error && !loadError && <p>{zh ? '未找到可用的外部应用' : 'No external apps found'}</p>}
        </div>
      )}
    </div>
  );
}
