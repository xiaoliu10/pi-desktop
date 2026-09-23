import { useEffect, useRef, useState } from 'react';
import type { SessionMode } from '@shared/types';
import { useStore } from '../store';
import { translate, type TextKey } from '../i18n';

const MODES: SessionMode[] = ['agent', 'plan', 'goal'];

export function TopBar() {
  const s = useStore();
  const t = (key: TextKey, params?: Record<string, string | number>) => translate(s.settings.language, key, params);
  const [modelOpen, setModelOpen] = useState(false);
  const modelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (modelRef.current && !modelRef.current.contains(e.target as Node)) setModelOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const meta = s.sessionMeta;
  const status = meta ? s.statuses[meta.id] ?? 'idle' : 'idle';
  const queued = meta ? s.queued[meta.id] ?? 0 : 0;

  const selectedModel = s.providers.flatMap((p) => p.models).find((m) => m.id === meta?.modelId);
  const statusLabel: Record<string, string> = {
    idle: t('status.idle'),
    running: t('status.running'),
    awaiting_permission: t('status.awaiting_permission'),
    awaiting_plan: t('status.awaiting_plan'),
  };

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-ink-800 bg-ink-900 px-4">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium">{meta ? meta.title : t('app.tagline')}</div>
      </div>

      {meta && (
        <>
          {/* status */}
          <div
            className={`chip ${
              status === 'running'
                ? 'bg-accent/15 text-accent'
                : status === 'idle'
                  ? 'bg-ink-800 text-ink-400'
                  : 'bg-amber-500/15 text-amber-400'
            }`}
          >
            {statusLabel[status]}
            {queued > 0 ? ` · ${t('chat.queued', { n: queued })}` : ''}
          </div>

          {/* mode */}
          <div className="flex overflow-hidden rounded-md border border-ink-700">
            {MODES.map((m) => (
              <button
                key={m}
                className={`px-2.5 py-1 text-xs capitalize transition-colors ${
                  meta.mode === m ? 'bg-accent text-white' : 'text-ink-300 hover:bg-ink-800'
                }`}
                onClick={() => void s.updateSession({ mode: m })}
                title={m === 'plan' ? 'Research first, approve a plan' : m === 'goal' ? 'Outcome-first' : 'Work directly'}
              >
                {t(`topbar.mode.${m}` as TextKey)}
              </button>
            ))}
          </div>

          {/* model picker */}
          <div className="relative" ref={modelRef}>
            <button
              className={`btn-outline max-w-56 ${selectedModel ? '' : 'text-amber-400'}`}
              onClick={() => setModelOpen((v) => !v)}
            >
              <span className="truncate">{selectedModel ? selectedModel.name : t('topbar.noModel')}</span>
              <span className="text-[9px]">▼</span>
            </button>
            {modelOpen && (
              <div className="absolute right-0 top-9 z-40 max-h-96 w-72 overflow-y-auto rounded-md border border-ink-700 bg-ink-850 py-1 shadow-2xl">
                {s.providers.length === 0 && (
                  <div className="px-3 py-2 text-xs text-ink-400">
                    {t('settings.noProviders')}
                    <button className="btn-primary ml-2" onClick={() => s.setSettingsOpen(true)}>
                      {t('settings.tab.models')}
                    </button>
                  </div>
                )}
                {s.providers.map((p) => (
                  <div key={p.id}>
                    <div className="px-3 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wider text-ink-500">
                      {p.name}
                    </div>
                    {p.models.map((m) => (
                      <button
                        key={m.id}
                        className={`block w-full px-3 py-1.5 text-left text-xs hover:bg-ink-700 ${
                          m.id === meta.modelId ? 'text-accent' : 'text-ink-200'
                        }`}
                        onClick={() => {
                          void s.updateSession({ modelId: m.id });
                          setModelOpen(false);
                        }}
                      >
                        {m.name}
                        <span className="ml-1.5 text-[10px] text-ink-500">{m.model}</span>
                      </button>
                    ))}
                  </div>
                ))}
                <div className="border-t border-ink-700 mt-1 pt-1">
                  <button
                    className="block w-full px-3 py-1.5 text-left text-xs text-ink-300 hover:bg-ink-700"
                    onClick={() => {
                      setModelOpen(false);
                      s.setSettingsOpen(true);
                    }}
                  >
                    ⚙ {t('settings.tab.models')}…
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* review */}
          <button
            className={`btn-outline ${s.reviewOpen ? '!border-accent !text-accent' : ''}`}
            onClick={s.toggleReview}
          >
            {t('topbar.review')}
            {s.changes.length > 0 && (
              <span className="rounded bg-ink-700 px-1 text-[10px] text-ink-200">{s.changes.length}</span>
            )}
          </button>
        </>
      )}
    </header>
  );
}
