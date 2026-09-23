import { useMemo, useState } from 'react';
import { useStore } from '../store';
import { translate, type TextKey } from '../i18n';

function timeLabel(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function Sidebar() {
  const s = useStore();
  const t = (key: TextKey) => translate(s.settings.language, key);
  const [query, setQuery] = useState('');
  const [menuFor, setMenuFor] = useState<string | null>(null);

  const isMac = s.platform === 'darwin';
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const active = s.sessions.filter((x) => !x.archived);
    const archived = s.sessions.filter((x) => x.archived);
    const match = (list: typeof s.sessions) =>
      q ? list.filter((x) => x.title.toLowerCase().includes(q)) : list;
    return { active: match(active), archived: match(archived) };
  }, [s.sessions, query]);

  const addProject = async () => {
    const dir = await window.pi.pickDirectory();
    if (dir) await s.addProject(dir);
  };

  const newSession = async () => {
    await s.newSession();
  };

  return (
    <aside
      className={`flex w-60 shrink-0 flex-col border-r border-ink-800 bg-ink-900 ${isMac ? 'pt-8' : ''}`}
    >
      <div className="flex items-center gap-2 px-4 pb-3 pt-2">
        <div className="flex h-6 w-6 items-center justify-center rounded-md bg-accent text-[13px] font-bold text-white">
          π
        </div>
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold">{t('app.title')}</div>
        </div>
      </div>

      {/* Projects */}
      <div className="px-2">
        <div className="flex items-center justify-between px-2 pb-1">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-500">{t('sidebar.projects')}</span>
          <button className="btn-ghost !px-1.5 !py-0.5" title={t('sidebar.addProject')} onClick={() => void addProject()}>
            +
          </button>
        </div>
        <ul className="space-y-0.5">
          {s.projects.map((p) => (
            <li key={p.id} className="group relative">
              <button
                className={`w-full truncate rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
                  s.activeProjectId === p.id ? 'bg-ink-800 text-ink-100' : 'text-ink-300 hover:bg-ink-850 hover:text-ink-100'
                }`}
                onClick={() => void s.selectProject(p.id)}
                title={p.path}
              >
                {p.name}
              </button>
              <button
                className="absolute right-1 top-1/2 hidden -translate-y-1/2 rounded px-1 text-ink-500 hover:text-red-400 group-hover:block"
                title={t('sidebar.removeProjectConfirm')}
                onClick={() => {
                  if (window.confirm(t('sidebar.removeProjectConfirm'))) void s.removeProject(p.id);
                }}
              >
                ×
              </button>
            </li>
          ))}
          {s.projects.length === 0 && (
            <li>
              <button className="btn-outline w-full justify-center" onClick={() => void addProject()}>
                {t('sidebar.addProject')}
              </button>
            </li>
          )}
        </ul>
      </div>

      {/* Sessions */}
      {s.activeProjectId && (
        <div className="mt-4 flex min-h-0 flex-1 flex-col px-2">
          <div className="flex items-center justify-between px-2 pb-1">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-500">{t('sidebar.sessions')}</span>
            <button className="btn-ghost !px-1.5 !py-0.5" title={t('sidebar.newSession')} onClick={() => void newSession()}>
              +
            </button>
          </div>
          <div className="px-1 pb-1.5">
            <input className="input" placeholder={t('sidebar.search')} value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto pb-2">
            <ul className="space-y-0.5">
              {filtered.active.map((sess) => (
                <SessionItem
                  key={sess.id}
                  id={sess.id}
                  title={sess.title}
                  ts={sess.updatedAt}
                  pinned={Boolean(sess.pinned)}
                  active={s.sessionMeta?.id === sess.id}
                  label={timeLabel(sess.updatedAt)}
                  menuOpen={menuFor === sess.id}
                  onMenu={(open) => setMenuFor(open ? sess.id : null)}
                  t={t}
                />
              ))}
            </ul>
            {filtered.archived.length > 0 && (
              <div className="mt-3">
                <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-600">
                  {t('session.archivedSection')}
                </div>
                <ul className="space-y-0.5 opacity-60">
                  {filtered.archived.map((sess) => (
                    <SessionItem
                      key={sess.id}
                      id={sess.id}
                      title={sess.title}
                      ts={sess.updatedAt}
                      pinned={false}
                      archived
                      active={s.sessionMeta?.id === sess.id}
                      label={timeLabel(sess.updatedAt)}
                      menuOpen={menuFor === sess.id}
                      onMenu={(open) => setMenuFor(open ? sess.id : null)}
                      t={t}
                    />
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Bottom */}
      <div className="mt-auto flex items-center justify-between border-t border-ink-800 px-3 py-2">
        <span className="text-[10px] text-ink-600">v{s.appVersion}</span>
        <div className="flex items-center gap-1">
          <button
            className="btn-ghost !px-1.5 text-[10px]"
            onClick={() => void s.setLanguage(s.settings.language === 'zh' ? 'en' : 'zh')}
            title="Language"
          >
            {s.settings.language === 'zh' ? 'EN' : '中'}
          </button>
          <button className="btn-ghost !px-1.5" title={t('sidebar.settings')} onClick={() => s.setSettingsOpen(true)}>
            ⚙
          </button>
        </div>
      </div>
    </aside>
  );
}

function SessionItem(props: {
  id: string;
  title: string;
  ts: number;
  pinned: boolean;
  archived?: boolean;
  active: boolean;
  label: string;
  menuOpen: boolean;
  onMenu: (open: boolean) => void;
  t: (key: TextKey) => string;
}) {
  const s = useStore();
  const { t } = props;
  return (
    <li className="group relative">
      <button
        className={`w-full rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
          props.active ? 'bg-ink-800 text-ink-100' : 'text-ink-300 hover:bg-ink-850 hover:text-ink-100'
        }`}
        onClick={() => void s.selectSession(props.id)}
      >
        <div className="flex items-center gap-1.5">
          {props.pinned && <span className="text-[10px] text-ink-400">📌</span>}
          <span className="min-w-0 flex-1 truncate">{props.title}</span>
          <span className="shrink-0 text-[10px] text-ink-600">{props.label}</span>
        </div>
      </button>
      <button
        className={`absolute right-1 top-1/2 -translate-y-1/2 rounded px-1 text-ink-500 hover:text-ink-100 ${
          props.menuOpen ? '' : 'opacity-0 group-hover:opacity-100'
        }`}
        onClick={(e) => {
          e.stopPropagation();
          props.onMenu(!props.menuOpen);
        }}
      >
        ⋯
      </button>
      {props.menuOpen && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => props.onMenu(false)} />
          <div className="absolute right-1 top-8 z-30 w-36 rounded-md border border-ink-700 bg-ink-850 py-1 shadow-xl">
            {[
              props.pinned
                ? { key: 'session.context.unpin' as TextKey, run: () => void s.updateSession({ pinned: false }) }
                : { key: 'session.context.pin' as TextKey, run: () => void s.updateSession({ pinned: true }) },
              props.archived
                ? { key: 'session.context.unarchive' as TextKey, run: () => void s.updateSession({ archived: false }) }
                : { key: 'session.context.archive' as TextKey, run: () => void s.updateSession({ archived: true }) },
              {
                key: 'session.context.rename' as TextKey,
                run: () => {
                  const title = window.prompt(t('session.context.rename'), props.title);
                  if (title && title.trim()) void s.updateSession({ title: title.trim() });
                },
              },
            ].map((item) => (
              <button
                key={item.key}
                className="block w-full px-3 py-1.5 text-left text-xs text-ink-200 hover:bg-ink-700"
                onClick={() => {
                  props.onMenu(false);
                  item.run();
                }}
              >
                {t(item.key)}
              </button>
            ))}
            <div className="my-1 border-t border-ink-700" />
            <button
              className="block w-full px-3 py-1.5 text-left text-xs text-red-400 hover:bg-ink-700"
              onClick={() => {
                props.onMenu(false);
                if (window.confirm(t('session.deleteConfirm'))) void s.deleteSession(props.id);
              }}
            >
              {t('session.context.delete')}
            </button>
          </div>
        </>
      )}
    </li>
  );
}
