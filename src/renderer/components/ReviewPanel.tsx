import { useState } from 'react';
import { useStore } from '../store';
import { translate, type TextKey } from '../i18n';
import { DiffView } from './DiffView';

export function ReviewPanel() {
  const s = useStore();
  const t = (key: TextKey) => translate(s.settings.language, key);
  const [openPath, setOpenPath] = useState<string | null>(null);

  return (
    <aside className="flex w-96 shrink-0 flex-col border-l border-ink-800 bg-ink-900">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-ink-800 px-4">
        <span className="text-xs font-semibold text-ink-200">{t('review.title')}</span>
        <button className="btn-ghost !px-1.5" onClick={s.toggleReview}>
          ×
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {s.changes.length === 0 ? (
          <div className="mt-8 text-center text-xs text-ink-500">{t('review.empty')}</div>
        ) : (
          <ul className="space-y-2">
            {s.changes.map((c) => {
              const open = openPath === c.path;
              return (
                <li key={c.path} className="card overflow-hidden">
                  <button
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-ink-850"
                    onClick={() => setOpenPath(open ? null : c.path)}
                  >
                    <span className="min-w-0 flex-1 truncate font-mono">{c.path}</span>
                    {c.created && <span className="chip bg-sky-500/15 text-sky-400">{t('review.created')}</span>}
                    <span className="text-emerald-400">+{c.additions}</span>
                    <span className="text-red-400">-{c.deletions}</span>
                  </button>
                  {open && (
                    <div className="border-t border-ink-800 p-2">
                      <DiffView diff={c.diff} compact />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}
