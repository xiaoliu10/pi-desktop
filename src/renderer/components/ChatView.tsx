import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { TranscriptEvent } from '@shared/types';
import { useStore } from '../store';
import { translate, type TextKey } from '../i18n';
import { DiffView } from './DiffView';
import { Composer } from './Composer';

const TOOL_ICONS: Record<string, string> = {
  list_dir: '📂',
  read_file: '📄',
  grep: '🔍',
  write_file: '✏️',
  edit_file: '✏️',
  run_command: '▶',
};

function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

function ToolCard({ call, result }: { call: TranscriptEvent & { t: 'tool_call' }; result?: TranscriptEvent & { t: 'tool_result' } }) {
  const s = useStore();
  const t = (key: TextKey) => translate(s.settings.language, key);
  const [open, setOpen] = useState(false);
  const failed = result && !result.ok;
  const hasDiff = Boolean(result?.diff && result.diff.hunks.length > 0);
  const showOpen = open || failed;

  let stateNode: React.ReactNode = null;
  if (!result) stateNode = <span className="text-ink-500">…</span>;
  else if (result.ok) stateNode = <span className="text-emerald-400">✓</span>;
  else if (result.error?.includes('Denied') || result.error?.includes('Blocked in Plan mode'))
    stateNode = <span className="text-amber-400">{t('tool.denied')}</span>;
  else stateNode = <span className="text-red-400">{t('tool.error')}</span>;

  return (
    <div className="card my-1.5 overflow-hidden text-xs">
      <button
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-ink-850"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="w-4 text-center">{TOOL_ICONS[call.name] ?? '🛠'}</span>
        <span className="font-mono text-ink-200">{call.name}</span>
        <span className="min-w-0 flex-1 truncate text-ink-400">{call.summary ?? ''}</span>
        {stateNode}
      </button>
      {showOpen && (
        <div className="space-y-2 border-t border-ink-800 px-3 py-2">
          <details>
            <summary className="cursor-pointer text-ink-400">arguments</summary>
            <pre className="mt-1 max-h-48 overflow-auto rounded bg-ink-950 p-2 font-mono text-[11px] text-ink-300">
              {JSON.stringify(call.args, null, 2)}
            </pre>
          </details>
          {result?.error && <div className="text-red-300">{result.error}</div>}
          {hasDiff && result?.diff && <DiffView diff={result.diff} compact />}
          {result?.output && (
            <div>
              <div className="mb-0.5 text-ink-500">{t('tool.output')}</div>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-ink-950 p-2 font-mono text-[11px] text-ink-300">
                {result.output}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ChatView() {
  const s = useStore();
  const t = (key: TextKey) => translate(s.settings.language, key);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  // Merge tool_call + tool_result into cards; other events pass through.
  type Item =
    | { kind: 'event'; event: TranscriptEvent }
    | { kind: 'tool'; call: Extract<TranscriptEvent, { t: 'tool_call' }>; result?: Extract<TranscriptEvent, { t: 'tool_result' }> };
  const items: Item[] = [];
  const resultByCall = new Map<string, TranscriptEvent & { t: 'tool_result' }>();
  for (const ev of s.events) {
    if (ev.t === 'tool_result') resultByCall.set(ev.callId, ev);
  }
  for (const ev of s.events) {
    if (ev.t === 'tool_result') continue;
    if (ev.t === 'tool_call') {
      items.push({ kind: 'tool', call: ev, result: resultByCall.get(ev.id) });
    } else {
      items.push({ kind: 'event', event: ev });
    }
  }

  const streamingEntries = Object.entries(s.streaming).filter(([, text]) => text.length > 0 || true);
  const meta = s.sessionMeta;
  const status = meta ? s.statuses[meta.id] ?? 'idle' : 'idle';
  const showPlanBanner =
    meta?.mode === 'plan' && !meta.planApproved && status === 'awaiting_plan';

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  });

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  if (!meta) {
    return (
      <div className="flex min-w-0 flex-1 items-center justify-center">
        {s.activeProjectId ? (
          <button className="btn-primary" onClick={() => void s.newSession()}>
            {t('sidebar.newSession')}
          </button>
        ) : (
          <div className="text-center text-sm text-ink-400">{t('chat.empty.title')}</div>
        )}
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <div className="mx-auto max-w-3xl">
          {items.length === 0 && streamingEntries.length === 0 && (
            <div className="mt-24 text-center">
              <div className="mb-2 text-lg font-semibold text-ink-200">{t('chat.empty.title')}</div>
              <p className="text-sm text-ink-400">{t('chat.empty.hint1')}</p>
              <p className="mt-1 text-sm text-ink-500">{t('chat.empty.hint2')}</p>
              <p className="mt-4 text-xs text-ink-600">{t('chat.empty.hint3')}</p>
            </div>
          )}

          {items.map((item) => {
            if (item.kind === 'tool') {
              return <ToolCard key={item.call.id} call={item.call} result={item.result} />;
            }
            const ev = item.event;
            switch (ev.t) {
              case 'user':
                return (
                  <div key={ev.id} className="my-3 rounded-lg border-l-2 border-accent bg-ink-900 px-4 py-2.5">
                    <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-ink-500">{t('chat.you')}</div>
                    <div className="whitespace-pre-wrap break-words text-sm">{ev.text}</div>
                  </div>
                );
              case 'assistant':
                return (
                  <div key={ev.id} className="my-3">
                    <Markdown text={ev.text} />
                  </div>
                );
              case 'notice':
                return (
                  <div key={ev.id} className="my-1 text-center text-xs italic text-ink-500">
                    {ev.text}
                  </div>
                );
              case 'error':
                return (
                  <div key={ev.id} className="my-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                    {ev.message}
                  </div>
                );
              case 'plan':
                return (
                  <div key={ev.id} className="my-1 text-center text-xs text-emerald-400">
                    ✓ {t('chat.approvePlan')}
                  </div>
                );
              default:
                return null;
            }
          })}

          {streamingEntries.map(([id, text]) => (
            <div key={id} className="my-3">
              {text ? <Markdown text={text} /> : <span className="inline-block animate-pulse text-ink-500">▋</span>}
            </div>
          ))}
        </div>
      </div>

      {showPlanBanner && (
        <div className="mx-auto mb-2 flex w-full max-w-3xl items-center justify-between rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-xs text-amber-300">
          <span>{t('chat.planBanner')}</span>
          <button className="btn-primary" onClick={() => void s.approvePlan()}>
            {t('chat.approvePlan')}
          </button>
        </div>
      )}

      <Composer />
    </div>
  );
}
