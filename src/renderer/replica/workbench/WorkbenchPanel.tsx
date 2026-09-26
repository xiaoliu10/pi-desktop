import { FilePathMenu } from './FilePathMenu';
import { FileCodeViewer } from './FileCodeViewer';
/**
 * Workbench panel replica (U06): Review / Files / Browser tabs in a right
 * side panel. Review shows demo diffs, Files a demo file browser, Browser an
 * explicit empty state (no external pages are loaded in this phase).
 */

import { useRef, useState } from 'react';
import type { WorkbenchProps } from '../contracts';
import { Icon } from '../Icons';
import { FileIcon } from '../FileIcon';
import { DiffBlock } from '../chat/ChatView';
import './workbench.css';

export function WorkbenchPanel(props: WorkbenchProps) {
  const [expanded, setExpanded] = useState<string | null>(props.selectedFile);
  // 原 `key={tool-preview-N}` 重挂载的语义（切换预览文件时展开该文件）改为 render 期比对，
  // 整棵子树不再因预览刷新而重建 —— 浏览器 tab 的 webview 由此得以保活。
  const lastFile = useRef(props.selectedFile);
  if (props.selectedFile !== lastFile.current) {
    lastFile.current = props.selectedFile;
    setExpanded(props.selectedFile);
  }
  // 浏览器 tab 打开过一次后常挂载（display:none 隐藏），切换 tab / 收起面板都不销毁 webview。
  const browserStarted = useRef(false);
  if (props.open && props.tab === 'browser' && props.browserPanel) browserStarted.current = true;
  if (!props.open && !browserStarted.current) return null;
  const selected = props.files.find((f) => f.path === props.selectedFile) ?? null;

  return (
    <aside className="pi-workbench" style={!props.open ? { display: 'none' } : undefined} aria-hidden={!props.open || undefined}>
      <header className="pi-workbench__tabs" role="tablist">
        {(
          [
            ['review', props.labels.review, 'diff'],
            ['files', props.labels.files, 'folder'],
            ['browser', props.labels.browser, 'globe'],
          ] as const
        ).map(([tab, label, icon]) => (
          <button
            key={tab}
            role="tab"
            aria-selected={props.tab === tab}
            className={`pi-workbench__tab ${props.tab === tab ? 'pi-workbench__tab--on' : ''}`}
            onClick={() => props.onSelectTab(tab)}
          >
            <Icon name={icon} size={14} />
            {label}
          </button>
        ))}
        <button className="pi-iconbtn pi-workbench__close" onClick={props.onToggle} aria-label={props.labels.close} title={props.labels.close}>
          <Icon name="x" size={15} />
        </button>
      </header>

      <div className="pi-workbench__body" style={props.tab === 'browser' && props.browserPanel ? { display: 'none' } : undefined}>
        {props.note && <p className="pi-workbench__preview-note">{props.note}</p>}
        {props.tab === 'review' && (
          <>
            {props.diffs.length === 0 && (
              <Empty icon="diff" title={props.labels.emptyReview} hint={props.labels.emptyReviewHint} />
            )}
            {props.diffs.map((d) => (
              <section key={d.path} className="pi-workbench__file">
                <div className="pi-workbench__filetoolbar"><button
                  className="pi-workbench__filehead"
                  aria-expanded={expanded === d.path}
                  onClick={() => setExpanded(expanded === d.path ? null : d.path)}
                >
                  <Icon name="chevron-down" size={12} style={{ transform: expanded === d.path ? 'none' : 'rotate(-90deg)' }} />
                  <FileIcon path={d.path} size={14} />
                  <span
                    className="pi-workbench__filepath"
                    role="button"
                    tabIndex={0}
                    title={props.labels.selectFile}
                    onClick={(e) => { e.stopPropagation(); props.onSelectFile?.(d.path); }}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); props.onSelectFile?.(d.path); } }}
                  >
                    {d.path}
                  </span>
                  {d.created && <span className="pi-chip pi-chip--new">{props.labels.created}</span>}
                  <span className="pi-diff__stat--add pi-workbench__stat">+{d.additions}</span>
                  <span className="pi-diff__stat--del pi-workbench__stat">−{d.deletions}</span>
                </button>
                <FilePathMenu path={d.path} cwd={props.cwd}/></div>
                {expanded === d.path && (
                  <div className="pi-workbench__filebody">
                    <DiffBlock diff={d} hideHead />
                  </div>
                )}
              </section>
            ))}
          </>
        )}

        {props.tab === 'files' && (
          <>
            <select
              className="pi-workbench__fileselect"
              value={props.selectedFile ?? ''}
              onChange={(e) => props.onSelectFile(e.target.value || null)}
              aria-label={props.labels.selectFile}
            >
              <option value="">{props.labels.selectFile}</option>
              {props.files.map((f) => (
                <option key={f.path} value={f.path}>
                  {f.path}
                </option>
              ))}
            </select>
            {!selected && props.files.length === 0 && (
              <Empty icon="folder" title={props.labels.emptyFiles} hint={props.labels.emptyFilesHint} />
            )}
            {selected && (
              <><div className="pi-workbench__filetoolbar"><span className="pi-workbench__filename" title={selected.path}>{selected.path}</span><FilePathMenu path={selected.path} cwd={props.cwd}/></div><FileCodeViewer path={selected.path} content={selected.excerpt.join('\n')} line={props.fileLine}/></>
            )}
          </>
        )}

        {props.tab === 'browser' && !props.browserPanel && (
          <Empty icon="globe" title={props.labels.emptyBrowser} hint={props.labels.emptyBrowserHint} />
        )}
      </div>

      {/* 稳定位置的浏览器插槽：切换 tab 只改 display，webview 不重挂载。 */}
      {browserStarted.current && props.browserPanel && (
        <div className="pi-workbench__browserslot" style={{ display: props.tab === 'browser' ? 'flex' : 'none' }}>
          {props.browserPanel}
        </div>
      )}
    </aside>
  );
}

function Empty({ icon, title, hint }: { icon: 'diff' | 'folder' | 'globe'; title: string; hint: string }) {
  return (
    <div className="pi-workbench__empty">
      <span className="pi-workbench__emptyicon">
        <Icon name={icon} size={18} />
      </span>
      <div className="pi-workbench__emptytitle">{title}</div>
      <div className="pi-workbench__emptyhint">{hint}</div>
    </div>
  );
}
