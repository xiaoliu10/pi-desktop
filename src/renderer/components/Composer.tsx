import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { translate, type TextKey } from '../i18n';

/** Depth-limited recursive file listing for @ mentions. */
async function buildFileIndex(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, prefix: string, depth: number): Promise<void> => {
    if (depth > 3 || out.length >= 2000) return;
    const entries = await window.pi.listDir(dir);
    for (const e of entries) {
      if (out.length >= 2000) return;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.kind === 'file') out.push(rel);
      else await walk(`${dir}/${e.name}`, rel, depth + 1);
    }
  };
  await walk(root, '', 0);
  return out;
}

export function Composer() {
  const s = useStore();
  const t = (key: TextKey) => translate(s.settings.language, key);
  const [text, setText] = useState('');
  const [files, setFiles] = useState<string[] | null>(null);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [selected, setSelected] = useState(0);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const meta = s.sessionMeta;
  const status = meta ? s.statuses[meta.id] ?? 'idle' : 'idle';
  const running = status === 'running' || status === 'awaiting_permission';

  const candidates = useMemo(() => {
    if (!mention || !files) return [];
    const q = mention.query.toLowerCase();
    return files.filter((f) => f.toLowerCase().includes(q)).slice(0, 8);
  }, [mention, files]);

  useEffect(() => setSelected(0), [mention?.query]);

  const updateMention = (value: string, caret: number) => {
    const upto = value.slice(0, caret);
    const at = upto.lastIndexOf('@');
    if (at >= 0 && !/[\s]/.test(upto.slice(at + 1))) {
      setMention({ start: at, query: upto.slice(at + 1) });
    } else {
      setMention(null);
    }
  };

  const onChange = async (value: string) => {
    setText(value);
    if (!files && value.includes('@') && meta) {
      const project = s.projects.find((p) => p.id === s.activeProjectId);
      if (project) void buildFileIndex(project.path).then(setFiles);
    }
    updateMention(value, value.length);
  };

  const insertMention = (path: string) => {
    if (!mention) return;
    const before = text.slice(0, mention.start);
    const after = text.slice(mention.start + 1 + mention.query.length);
    const next = `${before}@${path} ${after}`;
    setText(next);
    setMention(null);
    taRef.current?.focus();
  };

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || !meta) return;
    setText('');
    setMention(null);
    void s.sendPrompt(trimmed);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && candidates.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelected((v) => (v + 1) % candidates.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelected((v) => (v - 1 + candidates.length) % candidates.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        insertMention(candidates[selected]);
        return;
      }
      if (e.key === 'Escape') {
        setMention(null);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const autoResize = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(200, ta.scrollHeight)}px`;
  };

  return (
    <div className="shrink-0 px-6 pb-4">
      <div className="relative mx-auto max-w-3xl">
        {mention && candidates.length > 0 && (
          <div className="absolute bottom-full left-0 z-30 mb-1 w-80 overflow-hidden rounded-md border border-ink-700 bg-ink-850 shadow-2xl">
            {candidates.map((f, i) => (
              <button
                key={f}
                className={`block w-full truncate px-3 py-1.5 text-left font-mono text-[11px] ${
                  i === selected ? 'bg-ink-700 text-ink-100' : 'text-ink-300'
                }`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  insertMention(f);
                }}
              >
                {f}
              </button>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2 rounded-xl border border-ink-700 bg-ink-900 p-2 focus-within:border-accent">
          <textarea
            ref={taRef}
            className="max-h-[200px] min-h-[38px] flex-1 resize-none bg-transparent px-2 py-1.5 text-sm text-ink-100 placeholder-ink-500 outline-none"
            placeholder={t('chat.placeholder')}
            value={text}
            rows={1}
            onChange={(e) => {
              void onChange(e.target.value);
              autoResize();
            }}
            onKeyDown={onKeyDown}
          />
          {running ? (
            <button className="btn-danger" onClick={() => void s.interrupt()}>
              ■ {t('chat.stop')}
            </button>
          ) : (
            <button className="btn-primary" disabled={!text.trim() || !meta} onClick={submit}>
              {t('chat.send')} ↵
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
