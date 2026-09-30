import { useEffect, useRef, useState } from 'react';
import { Icon } from '../replica/Icons';
import type { ExternalApp } from '../../shared/open-with';
import { usePiStore } from './adapter';

/** 顶栏「打开方式」图标按钮：只展示当前应用图标，点击弹下拉；
 *  列表内选应用 = 用它打开当前项目并记住偏好。Escape / 外部点击关闭，
 *  无 cwd 时禁用。错误显示在下拉面板内（role="alert"）。 */
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

  // 列表内选应用 = 用它打开当前项目并记住偏好；打开失败时错误留在面板内，菜单不关。
  const pickAndOpen = async (id: string) => {
    if (!cwd || busy) return;
    setBusy(true); setError('');
    try {
      await window.localPi!.openWith(cwd, id);
      setOpen(false); trigger.current?.focus();
      try {
        await window.localPi!.saveDesktopSettings({ openWithApp: id });
        const snapshot = await window.localPi!.settingsSnapshot();
        usePiStore.setState({ desktopPreferences: snapshot.preferences });
      } catch { /* 偏好保存失败不影响本次打开 */ }
    } catch (e) {
      placeMenu(); setError((e as Error).message); setOpen(true);
    } finally { setBusy(false); }
  };

  const openLabel = selected
    ? zh ? `打开方式：${appName(selected)}` : `Open with: ${appName(selected)}`
    : zh ? '打开当前项目' : 'Open current project';
  return (
    <div className="pi-openwith" ref={root}>
      <button
        ref={trigger}
        className="pi-openwith__iconbtn"
        disabled={!cwd || busy || !selected}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={openLabel}
        title={cwd ? `${openLabel}（${zh ? '点击选择其他应用' : 'click to pick another app'}）` : zh ? '没有可打开的项目目录' : 'No project folder to open'}
        onClick={() => {
          placeMenu();
          setOpen(v => !v); setError('');
        }}
      >
        <span className="pi-openwith__appicon">{selected?.icon ? <img src={selected.icon} alt="" width={17} height={17} /> : <Icon name={selected?.kind === 'terminal' ? 'terminal' : selected?.kind === 'editor' ? 'code' : 'folder'} size={16} />}</span>
        <Icon name="chevron-down" size={12} className="pi-openwith__chevron" />
      </button>
      {open && (
        <div className="pi-project-menu pi-openwith__menu" style={position} role="menu" aria-label={zh ? '打开方式' : 'Open with'}>
          {loadError && <p role="alert">{loadError}</p>}
          {error && !loadError && <p role="alert">{error}</p>}
          {(apps ?? []).map(app => (
            <button key={app.id} role="menuitemradio" aria-checked={app.id === selected?.id} autoFocus={app.id === selected?.id} disabled={busy} title={cwd ? (zh ? `用 ${appName(app)} 打开当前项目` : `Open current project in ${appName(app)}`) : appName(app)} onClick={() => { void pickAndOpen(app.id); }}>
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
