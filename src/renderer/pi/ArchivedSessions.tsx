import { useState } from 'react';
import { Icon } from '../replica/Icons';
import { AUTO_DELETE_ARCHIVED_DAYS, DEFAULT_AUTO_DELETE_ARCHIVED_DAYS, type DesktopPreferences } from '../../shared/settings';
import { usePiStore } from './adapter';

/**
 * Archived-chats panel. Embedded mode renders inside the settings page
 * (查询入口在设置里)；overlay mode keeps the standalone dialog for hotlinks.
 *
 * 删除语义两种，文案需说清区别：
 * - 手动删除（每行按钮）：会话文件移到系统废纸篓，可恢复；
 * - 自动删除（下方开关）：归档超过保留时长的会话被定时永久删除，不可恢复。
 */
export function ArchivedSessions({ onClose, embedded = false }: { onClose?: () => void; embedded?: boolean }) {
  const s = usePiStore();
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [savingPrefs, setSavingPrefs] = useState(false);
  const [prefsError, setPrefsError] = useState('');
  const zh = s.lang === 'zh';
  const autoDelete = s.desktopPreferences?.autoDeleteArchived === true;
  const deleteDays = s.desktopPreferences?.autoDeleteArchivedDays ?? DEFAULT_AUTO_DELETE_ARCHIVED_DAYS;
  const items = s.archivedKeys
    .map((key) => ({ key, session: s.sessions.find((session) => session.key === key) }))
    .filter(({ key, session }) => `${s.renames[key] ?? session?.name ?? key} ${session?.cwd ?? ''}`.toLowerCase().includes(query.toLowerCase()));

  // 开关/天数改动即保存（主进程保存后 200ms 触发一次清理扫描）；失败回滚本地状态。
  const saveDeletePrefs = async (patch: Partial<Pick<DesktopPreferences, 'autoDeleteArchived' | 'autoDeleteArchivedDays'>>) => {
    if (savingPrefs) return;
    setSavingPrefs(true);
    setPrefsError('');
    const previous = s.desktopPreferences;
    usePiStore.setState((state) => ({ desktopPreferences: { ...(state.desktopPreferences ?? { behavior: 'followUp', permission: 'ask', shortcuts: {}, projects: [] }), ...patch } as DesktopPreferences }));
    try {
      await window.localPi!.saveDesktopSettings(patch);
    } catch (e) {
      usePiStore.setState({ desktopPreferences: previous });
      setPrefsError(String((e as Error).message || e));
    } finally {
      setSavingPrefs(false);
    }
  };

  const remove = async (key: string, name: string) => {
    if (!window.confirm(zh
      ? `删除归档会话「${name}」？\n会话文件将移到系统废纸篓，可从废纸篓恢复。`
      : `Delete archived chat "${name}"?\nThe session file moves to the system Trash and can be restored from there.`)) return;
    setDeleting(key);
    await s.deleteArchivedSession(key);
    setDeleting(null);
  };

  const autoDeleteCard = (
    <section className="pi-features__card pi-archive-autodelete">
      <h2>{zh ? '自动删除归档任务' : 'Auto-delete archived chats'}</h2>
      <label className="pi-features__check">
        <input
          type="checkbox"
          checked={autoDelete}
          disabled={savingPrefs}
          onChange={(e) => void saveDeletePrefs({ autoDeleteArchived: e.target.checked })}
        />
        {zh ? '开启自动删除' : 'Enable auto-delete'}
      </label>
      <label>
        {zh ? '归档保留时长' : 'Archive retention'}
        <select
          aria-label={zh ? '自动删除保留时长' : 'Auto-delete retention'}
          value={deleteDays}
          disabled={savingPrefs || !autoDelete}
          onChange={(e) => void saveDeletePrefs({ autoDeleteArchivedDays: Number(e.target.value) })}
        >
          {AUTO_DELETE_ARCHIVED_DAYS.map((d) => <option key={d} value={d}>{zh ? `${d} 天` : `${d} days`}</option>)}
        </select>
      </label>
      <p>
        {zh
          ? '开启后，归档超过保留时长且未再操作的会话会被定时永久删除（不进废纸篓，无法恢复）；运行中或等待确认的任务不会被删除。下方列表里的「删除」按钮是移到系统废纸篓，可恢复。'
          : 'When enabled, chats archived longer than the retention period are permanently deleted on a schedule (not moved to Trash; unrecoverable). Running or awaiting-confirmation tasks are never deleted. The per-row Delete button below moves files to the system Trash instead.'}
      </p>
      {prefsError && <p role="alert">{prefsError}</p>}
    </section>
  );

  const body = (
    <>
      <input
        autoFocus
        aria-label={zh ? '搜索已归档会话' : 'Search archived chats'}
        placeholder={zh ? '搜索名称或项目…' : 'Search chats or projects…'}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {s.error && <p role="alert">{s.error}</p>}
      <div className="pi-archive-dialog__list">
        {items.map(({ key, session }) => (
          <div className="pi-archive-dialog__row" key={key}>
            <Icon name="archive" size={17} />
            <div>
              <strong>{s.renames[key] ?? session?.name ?? (zh ? '会话文件暂不可用' : 'Session file unavailable')}</strong>
              <small>{session?.cwd ?? key}</small>
            </div>
            <button
              className="pi-btn pi-btn--outline"
              disabled={!!pending || !!deleting}
              onClick={async () => {
                setPending(key);
                await s.setSessionArchived(key, false);
                setPending(null);
              }}
            >
              {pending === key ? (zh ? '恢复中…' : 'Restoring…') : zh ? '恢复' : 'Restore'}
            </button>
            <button
              className="pi-btn pi-btn--ghost"
              disabled={!!pending || !!deleting}
              onClick={() => void remove(key, s.renames[key] ?? session?.name ?? key)}
            >
              {deleting === key ? (zh ? '删除中…' : 'Deleting…') : zh ? '删除' : 'Delete'}
            </button>
          </div>
        ))}
        {!items.length && <p>{query ? (zh ? '没有匹配的归档会话' : 'No matching chats') : zh ? '还没有归档会话' : 'No archived chats'}</p>}
      </div>
    </>
  );
  if (embedded) {
    return (
      <>
        {autoDeleteCard}
        <section className="pi-features__card pi-features__card--archived">
          <h2>{zh ? '已归档会话' : 'Archived chats'}</h2>
          <p>{zh ? '归档仅隐藏 Desktop 中的会话，原始 pi 会话文件仍保留；在这里搜索、恢复或删除。' : 'Archiving hides chats in Desktop and keeps the original pi session files; search, restore, or delete here.'}</p>
          {body}
        </section>
      </>
    );
  }
  return (
    <div className="pi-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && onClose) onClose(); }}>
      <div className="pi-archive-dialog" role="dialog" aria-modal="true" aria-label={zh ? '已归档会话' : 'Archived chats'}>
        <header>
          <h2>{zh ? '已归档会话' : 'Archived chats'}</h2>
          <button className="pi-iconbtn" aria-label={zh ? '关闭归档列表' : 'Close archive'} onClick={onClose}><Icon name="x" /></button>
        </header>
        <p>{zh ? '归档仅隐藏 Desktop 中的会话，原始 pi 会话文件仍保留。' : 'Archiving hides chats in Desktop and keeps the original pi session files.'}</p>
        {body}
      </div>
    </div>
  );
}
