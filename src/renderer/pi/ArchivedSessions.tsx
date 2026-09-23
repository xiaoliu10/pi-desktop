import { useState } from 'react';
import { Icon } from '../replica/Icons';
import { usePiStore } from './adapter';

/**
 * Archived-chats panel. Embedded mode renders inside the settings page
 * (查询入口在设置里)；overlay mode keeps the standalone dialog for hotlinks.
 */
export function ArchivedSessions({ onClose, embedded = false }: { onClose?: () => void; embedded?: boolean }) {
  const s = usePiStore();
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const zh = s.lang === 'zh';
  const items = s.archivedKeys
    .map((key) => ({ key, session: s.sessions.find((session) => session.key === key) }))
    .filter(({ key, session }) => `${s.renames[key] ?? session?.name ?? key} ${session?.cwd ?? ''}`.toLowerCase().includes(query.toLowerCase()));
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
              disabled={!!pending}
              onClick={async () => {
                setPending(key);
                await s.setSessionArchived(key, false);
                setPending(null);
              }}
            >
              {pending === key ? (zh ? '恢复中…' : 'Restoring…') : zh ? '恢复' : 'Restore'}
            </button>
          </div>
        ))}
        {!items.length && <p>{query ? (zh ? '没有匹配的归档会话' : 'No matching chats') : zh ? '还没有归档会话' : 'No archived chats'}</p>}
      </div>
    </>
  );
  if (embedded) {
    return (
      <section className="pi-features__card pi-features__card--archived">
        <h2>{zh ? '已归档会话' : 'Archived chats'}</h2>
        <p>{zh ? '归档仅隐藏 Desktop 中的会话，原始 pi 会话文件仍保留；在这里搜索并恢复。' : 'Archiving hides chats in Desktop and keeps the original pi session files; search and restore here.'}</p>
        {body}
      </section>
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
