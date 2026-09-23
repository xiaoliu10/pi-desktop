import { useStore } from '../store';
import { translate, type TextKey } from '../i18n';

export function PermissionDialog() {
  const s = useStore();
  const t = (key: TextKey) => translate(s.settings.language, key);
  const request = s.permissionRequest;
  if (!request) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-[26rem] rounded-xl border border-ink-700 bg-ink-900 p-5 shadow-2xl">
        <div className="mb-1 text-sm font-semibold text-amber-400">⚠ {t('permission.title')}</div>
        <p className="mb-3 text-xs text-ink-400">{t('permission.body')}</p>
        <div className="mb-4 rounded-md bg-ink-950 px-3 py-2">
          <div className="font-mono text-xs text-ink-100">{request.tool}</div>
          <div className="mt-1 break-all font-mono text-[11px] text-ink-400">{request.summary}</div>
        </div>
        <div className="flex justify-end gap-2">
          <button className="btn-danger" onClick={() => void s.respondPermission('deny')}>
            {t('permission.deny')}
          </button>
          <button className="btn-outline" onClick={() => void s.respondPermission('allow_session')}>
            {t('permission.allowSession')}
          </button>
          <button className="btn-primary" onClick={() => void s.respondPermission('allow_once')}>
            {t('permission.allowOnce')}
          </button>
        </div>
      </div>
    </div>
  );
}
