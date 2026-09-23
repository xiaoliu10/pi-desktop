import type { FileDiff } from '@shared/types';

export function DiffView({ diff, compact }: { diff: FileDiff; compact?: boolean }) {
  return (
    <div className={`overflow-hidden rounded-md border border-ink-800 font-mono ${compact ? 'text-[11px]' : 'text-xs'}`}>
      {diff.hunks.length === 0 && <div className="px-3 py-2 text-ink-500">no changes</div>}
      {diff.hunks.map((hunk, hi) => (
        <div key={hi}>
          <div className="border-y border-ink-800 bg-ink-850 px-3 py-0.5 text-[10px] text-ink-400">
            @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
          </div>
          {hunk.lines.map((line, li) => (
            <div
              key={li}
              className={`whitespace-pre-wrap break-all px-3 py-px ${
                line.type === '+' ? 'diff-line-add' : line.type === '-' ? 'diff-line-del' : 'diff-line-ctx'
              }`}
            >
              <span className="mr-2 inline-block w-2 select-none text-ink-600">{line.type}</span>
              {line.text || ' '}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
