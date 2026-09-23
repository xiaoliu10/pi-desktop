import { useEffect, useState } from 'react';
import type { PermissionMode, ProviderView } from '@shared/types';
import { useStore } from '../store';
import { translate, type TextKey } from '../i18n';

interface ModelDraft {
  name: string;
  model: string;
  contextWindow: string;
  maxOutputTokens: string;
  supportsReasoning: boolean;
}

interface ProviderDraft {
  id?: string;
  type: ProviderView['type'];
  name: string;
  baseUrl: string;
  apiKeyPlain: string;
  clearApiKey: boolean;
  models: ModelDraft[];
}

function emptyDraft(type: ProviderView['type'] = 'openai-compatible'): ProviderDraft {
  return { type, name: '', baseUrl: '', apiKeyPlain: '', clearApiKey: false, models: [] };
}

function draftFrom(p: ProviderView): ProviderDraft {
  return {
    id: p.id,
    type: p.type,
    name: p.name,
    baseUrl: p.baseUrl ?? '',
    apiKeyPlain: '',
    clearApiKey: false,
    models: p.models.map((m) => ({
      name: m.name,
      model: m.model,
      contextWindow: m.contextWindow ? String(m.contextWindow) : '',
      maxOutputTokens: m.maxOutputTokens ? String(m.maxOutputTokens) : '',
      supportsReasoning: Boolean(m.supportsReasoning),
    })),
  };
}

type Tab = 'general' | 'models' | 'about';

export function SettingsDialog() {
  const s = useStore();
  const t = (key: TextKey) => translate(s.settings.language, key);
  const [tab, setTab] = useState<Tab>('models');
  const [draft, setDraft] = useState<ProviderDraft | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') s.setSettingsOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [s]);

  const editNew = () => setDraft(emptyDraft());
  const editProvider = (p: ProviderView) => setDraft(draftFrom(p));

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      await window.pi.saveProvider({
        id: draft.id,
        type: draft.type,
        name: draft.name.trim() || 'Provider',
        baseUrl: draft.baseUrl.trim() || undefined,
        apiKeyPlain: draft.apiKeyPlain || undefined,
        clearApiKey: draft.clearApiKey,
        models: draft.models
          .filter((m) => m.model.trim())
          .map((m) => ({
            name: m.name.trim() || m.model.trim(),
            model: m.model.trim(),
            contextWindow: m.contextWindow ? Number(m.contextWindow) : undefined,
            maxOutputTokens: m.maxOutputTokens ? Number(m.maxOutputTokens) : undefined,
            supportsReasoning: m.supportsReasoning || undefined,
          })),
      });
      await s.reloadProviders();
      setDraft(null);
    } finally {
      setSaving(false);
    }
  };

  const patchDraft = (patch: Partial<ProviderDraft>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="flex h-[600px] w-[820px] overflow-hidden rounded-xl border border-ink-700 bg-ink-900 shadow-2xl">
        {/* tabs */}
        <div className="flex w-40 shrink-0 flex-col border-r border-ink-800 bg-ink-950 p-3">
          <div className="mb-3 px-1 text-sm font-semibold">{t('settings.title')}</div>
          {(
            [
              ['models', t('settings.tab.models')],
              ['general', t('settings.tab.general')],
              ['about', t('settings.tab.about')],
            ] as Array<[Tab, string]>
          ).map(([id, label]) => (
            <button
              key={id}
              className={`mb-0.5 rounded-md px-3 py-1.5 text-left text-xs ${
                tab === id ? 'bg-ink-800 text-ink-100' : 'text-ink-400 hover:bg-ink-850'
              }`}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>

        {/* content */}
        <div className="min-w-0 flex-1 overflow-y-auto p-5">
          {tab === 'general' && (
            <div className="space-y-5">
              <div>
                <div className="mb-1.5 text-xs font-medium text-ink-300">{t('settings.language')}</div>
                <div className="flex gap-2">
                  {(['zh', 'en'] as const).map((lang) => (
                    <button
                      key={lang}
                      className={`btn-outline ${s.settings.language === lang ? '!border-accent !text-accent' : ''}`}
                      onClick={() => void s.setLanguage(lang)}
                    >
                      {lang === 'zh' ? '简体中文' : 'English'}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div className="mb-1.5 text-xs font-medium text-ink-300">{t('settings.permissionMode')}</div>
                <select
                  className="input"
                  value={s.settings.permissionMode}
                  onChange={(e) => void s.setSettings({ permissionMode: e.target.value as PermissionMode })}
                >
                  <option value="ask">{t('settings.permissionMode.ask')}</option>
                  <option value="autoEdit">{t('settings.permissionMode.autoEdit')}</option>
                  <option value="fullAccess">{t('settings.permissionMode.fullAccess')}</option>
                </select>
              </div>
            </div>
          )}

          {tab === 'models' && !draft && (
            <div>
              <div className="mb-3 flex items-center justify-between">
                <span className="text-xs font-medium text-ink-300">{t('settings.providers')}</span>
                <button className="btn-primary" onClick={editNew}>
                  + {t('settings.addProvider')}
                </button>
              </div>
              {s.providers.length === 0 && <div className="text-xs text-ink-500">{t('settings.noProviders')}</div>}
              <ul className="space-y-2">
                {s.providers.map((p) => (
                  <li key={p.id} className="card flex items-center gap-3 px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-medium text-ink-100">{p.name}</div>
                      <div className="text-[11px] text-ink-500">
                        {p.type}
                        {p.baseUrl ? ` · ${p.baseUrl}` : ''}
                        {` · ${p.models.length} models`}
                      </div>
                    </div>
                    {p.hasApiKey && <span className="chip bg-emerald-500/15 text-emerald-400">🔑</span>}
                    <button className="btn-outline" onClick={() => editProvider(p)}>
                      {t('settings.edit')}
                    </button>
                    <button
                      className="btn-danger"
                      onClick={() => {
                        if (window.confirm(t('settings.deleteProviderConfirm'))) {
                          void window.pi.deleteProvider(p.id).then(() => s.reloadProviders());
                        }
                      }}
                    >
                      {t('settings.delete')}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {tab === 'models' && draft && (
            <div className="space-y-4 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="mb-1 block text-ink-400">{t('settings.provider.type')}</span>
                  <select
                    className="input"
                    value={draft.type}
                    onChange={(e) => patchDraft({ type: e.target.value as ProviderView['type'] })}
                  >
                    <option value="openai-compatible">OpenAI Compatible</option>
                    <option value="anthropic">Anthropic</option>
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1 block text-ink-400">{t('settings.provider.name')}</span>
                  <input className="input" value={draft.name} onChange={(e) => patchDraft({ name: e.target.value })} placeholder="OpenAI / DeepSeek / Ollama…" />
                </label>
                <label className="block">
                  <span className="mb-1 block text-ink-400">{t('settings.provider.baseUrl')}</span>
                  <input
                    className="input"
                    value={draft.baseUrl}
                    onChange={(e) => patchDraft({ baseUrl: e.target.value })}
                    placeholder="https://api.openai.com/v1"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-ink-400">
                    {t('settings.provider.apiKey')}
                    {draft.id && !draft.apiKeyPlain && <span className="ml-2 text-emerald-500">🔑</span>}
                  </span>
                  <input
                    className="input"
                    type="password"
                    value={draft.apiKeyPlain}
                    onChange={(e) => patchDraft({ apiKeyPlain: e.target.value, clearApiKey: false })}
                    placeholder={draft.id ? t('settings.provider.apiKeyPlaceholder') : 'sk-…'}
                  />
                </label>
              </div>

              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="text-ink-400">{t('settings.provider.models')}</span>
                  <button
                    className="btn-outline"
                    onClick={() =>
                      patchDraft({
                        models: [...draft.models, { name: '', model: '', contextWindow: '', maxOutputTokens: '', supportsReasoning: false }],
                      })
                    }
                  >
                    + {t('settings.provider.addModel')}
                  </button>
                </div>
                <div className="space-y-2">
                  {draft.models.map((m, i) => (
                    <div key={i} className="card grid grid-cols-[1fr_1fr_100px_100px_auto] items-center gap-2 p-2">
                      <input
                        className="input"
                        placeholder={t('settings.model.displayName')}
                        value={m.name}
                        onChange={(e) => {
                          const models = [...draft.models];
                          models[i] = { ...m, name: e.target.value };
                          patchDraft({ models });
                        }}
                      />
                      <input
                        className="input font-mono"
                        placeholder={t('settings.model.modelId')}
                        value={m.model}
                        onChange={(e) => {
                          const models = [...draft.models];
                          models[i] = { ...m, model: e.target.value };
                          patchDraft({ models });
                        }}
                      />
                      <input
                        className="input"
                        placeholder={t('settings.model.context')}
                        value={m.contextWindow}
                        onChange={(e) => {
                          const models = [...draft.models];
                          models[i] = { ...m, contextWindow: e.target.value.replace(/\D/g, '') };
                          patchDraft({ models });
                        }}
                      />
                      <input
                        className="input"
                        placeholder={t('settings.model.maxOutput')}
                        value={m.maxOutputTokens}
                        onChange={(e) => {
                          const models = [...draft.models];
                          models[i] = { ...m, maxOutputTokens: e.target.value.replace(/\D/g, '') };
                          patchDraft({ models });
                        }}
                      />
                      <button
                        className="btn-danger"
                        onClick={() => patchDraft({ models: draft.models.filter((_, j) => j !== i) })}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex justify-end gap-2 border-t border-ink-800 pt-3">
                <button className="btn-ghost" onClick={() => setDraft(null)}>
                  {t('common.cancel')}
                </button>
                <button className="btn-primary" disabled={saving} onClick={() => void save()}>
                  {t('settings.save')}
                </button>
              </div>
            </div>
          )}

          {tab === 'about' && (
            <div className="space-y-3 text-xs text-ink-300">
              <div>
                <span className="text-ink-500">{t('settings.about.version')}: </span>
                v{s.appVersion}
              </div>
              <div>
                <span className="text-ink-500">{t('settings.about.userData')}: </span>
                <span className="font-mono text-[11px]">{s.userData}</span>
              </div>
              <div>
                <span className="text-ink-500">{t('settings.about.repo')}: </span>
                <a className="text-accent underline" href="https://github.com/vastsa/PI-Desktop" target="_blank" rel="noreferrer">
                  vastsa/PI-Desktop
                </a>
              </div>
              <p className="pt-2 text-[11px] leading-relaxed text-ink-500">
                Local-first: conversations are stored as JSONL on your machine, API keys live in the OS keychain,
                and model requests go directly to the provider you configure.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
