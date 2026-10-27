import { FilePathMenu } from './FilePathMenu';
import { FileCodeViewer } from './FileCodeViewer';
/**
 * Workbench panel replica (U06): Review / Files / Browser tabs in a right
 * side panel. Review shows demo diffs, Files a demo file browser, Browser an
 * explicit empty state (no external pages are loaded in this phase).
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { WorkbenchProps, WorkbenchTab } from '../contracts';
import { Icon } from '../Icons';
import { FileIcon } from '../FileIcon';
import { DiffBlock } from '../chat/ChatView';
import './workbench.css';

// openLocalFile 来自 PR #166（file:// 链接打开），旧 runtime 没有该 API 时隐藏入口。
const localPiApi = (): { openLocalFile?: (path: string) => Promise<unknown> } | undefined =>
  (window as unknown as { localPi?: { openLocalFile?: (path: string) => Promise<unknown> } }).localPi;
const canOpenLocalFile = (): boolean => typeof localPiApi()?.openLocalFile === 'function';
const openLocalFileSafe = (path: string): void => {
  void localPiApi()?.openLocalFile?.(path).catch(() => { /* 打开失败不打断预览 */ });
};

export function WorkbenchPanel(props: WorkbenchProps) {
  const [expanded, setExpanded] = useState<string | null>(props.selectedFile);
  // HTML 交付文件：默认渲染效果，可切源码；切换预览文件时回到渲染视图。
  const [htmlPreview, setHtmlPreview] = useState(true);
  // 图片灯箱：面板窄，点击放大到全屏（复用聊天的 pi-lightbox 样式，portal 到 body）。
  const [lightbox, setLightbox] = useState(false);
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setLightbox(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightbox]);
  // 原 `key={tool-preview-N}` 重挂载的语义（切换预览文件时展开该文件）改为 render 期比对，
  // 整棵子树不再因预览刷新而重建 —— 浏览器 tab 的 webview 由此得以保活。
  const lastFile = useRef(props.selectedFile);
  if (props.selectedFile !== lastFile.current) {
    lastFile.current = props.selectedFile;
    setExpanded(props.selectedFile);
    setHtmlPreview(true);
  }
  // 浏览器 tab 打开过一次后常挂载（display:none 隐藏），切换 tab / 收起面板都不销毁 webview。
  const browserStarted = useRef(false);
  if (props.open && props.tab === 'browser' && props.browserPanel) browserStarted.current = true;
  // 辅助对话插槽同款 keep-alive：对话状态（绑定/草稿/滚动）跨 tab 切换与面板收起保留。
  const auxStarted = useRef(false);
  if (props.open && props.tab === 'aux' && props.sidecarPanel) auxStarted.current = true;
  if (!props.open && !browserStarted.current && !auxStarted.current) return null;
  const selected = props.files.find((f) => f.path === props.selectedFile) ?? null;

  return (
    <aside className="pi-workbench" style={!props.open ? { display: 'none' } : undefined} aria-hidden={!props.open || undefined}>
      <header className="pi-workbench__tabs" role="tablist">
        {(
          [
            ['review', props.labels.review, 'diff'],
            ['files', props.labels.files, 'folder'],
            ['browser', props.labels.browser, 'globe'],
            ['aux', props.labels.auxiliary, 'chat'],
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

      {props.tab === 'home' && <WorkbenchHome labels={props.labels} hasAuxiliary={Boolean(props.sidecarPanel)} onPick={props.onSelectTab} />}
      <div className="pi-workbench__body" style={props.tab === 'browser' && props.browserPanel || props.tab === 'aux' && props.sidecarPanel || props.tab === 'home' ? { display: 'none' } : undefined}>
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
              <><div className="pi-workbench__filetoolbar"><span className="pi-workbench__filename" title={selected.path}>{selected.path}</span><FilePathMenu path={selected.path} cwd={props.cwd}/></div>
                {props.image
                  ? <button type="button" className="pi-workbench__imgbtn" title="点击放大" onClick={() => setLightbox(true)}>
                      <img className="pi-workbench__img" src={`data:${props.image.mime};base64,${props.image.base64}`} alt={selected.path} />
                    </button>
                  : /\.html?$/i.test(selected.path) ? (() => {
                      const content = selected.excerpt.join('\n');
                      return (
                        <>
                          <div className="pi-workbench__filetoolbar pi-workbench__htmlbar">
                            <div className="pi-workbench__htmlmodes" role="group" aria-label="HTML 查看方式">
                              <button type="button" className={`pi-workbench__htmlmode ${htmlPreview ? 'is-active' : ''}`} aria-pressed={htmlPreview} onClick={() => setHtmlPreview(true)}>渲染</button>
                              <button type="button" className={`pi-workbench__htmlmode ${!htmlPreview ? 'is-active' : ''}`} aria-pressed={!htmlPreview} onClick={() => setHtmlPreview(false)}>源码</button>
                            </div>
                            {canOpenLocalFile() && <button type="button" className="pi-workbench__htmlopen" title="用系统默认应用打开" onClick={() => openLocalFileSafe(selected.path)}>系统打开</button>}
                          </div>
                          {htmlPreview
                            // sandbox：opaque origin（无同源）+ 脚本可跑但碰不到宿主/DOM/存储；
                            // 交付 HTML 常含内联样式与脚本，不能为它放宽全局 CSP。
                            ? <iframe className="pi-workbench__htmlframe" sandbox="allow-scripts" srcDoc={content} title={selected.path} />
                            : <FileCodeViewer path={selected.path} content={content} line={props.fileLine}/>}
                        </>
                      );
                    })()
                  : <FileCodeViewer path={selected.path} content={selected.excerpt.join('\n')} line={props.fileLine}/>}
              </>
            )}
          </>
        )}

        {props.tab === 'browser' && !props.browserPanel && (
          <Empty icon="globe" title={props.labels.emptyBrowser} hint={props.labels.emptyBrowserHint} />
        )}

        {props.tab === 'aux' && !props.sidecarPanel && (
          <Empty icon="chat" title={props.labels.auxiliary} hint={props.labels.homeAuxiliary} />
        )}
      </div>

      {/* 稳定位置的浏览器插槽：切换 tab 只改 display，webview 不重挂载。 */}
      {browserStarted.current && props.browserPanel && (
        <div className="pi-workbench__browserslot" style={{ display: props.tab === 'browser' ? 'flex' : 'none' }}>
          {props.browserPanel}
        </div>
      )}
      {/* 辅助对话插槽：同款 keep-alive，对话状态跨 tab/收起保留。 */}
      {auxStarted.current && props.sidecarPanel && (
        <div className="pi-workbench__auxslot" style={{ display: props.tab === 'aux' ? 'flex' : 'none' }}>
          {props.sidecarPanel}
        </div>
      )}
      {lightbox && props.image && createPortal(
        <div className="pi-lightbox" role="dialog" aria-modal="true" aria-label={selected?.path} onClick={() => setLightbox(false)}>
          <div className="pi-lightbox__bar" onClick={e => e.stopPropagation()}>
            <button type="button" className="pi-lightbox__btn" title="关闭" aria-label="关闭" onClick={() => setLightbox(false)}><Icon name="x" size={22} /></button>
          </div>
          <img className="pi-lightbox__img" src={`data:${props.image.mime};base64,${props.image.base64}`} alt={selected?.path} onClick={(e) => e.stopPropagation()} />
        </div>,
        document.body,
      )}
    </aside>
  );
}

/** ZCode 式功能选择页：面板打开的默认落点，四张卡片进入各自 tab。 */
function WorkbenchHome({ labels, hasAuxiliary, onPick }: {
  labels: WorkbenchProps['labels'];
  hasAuxiliary: boolean;
  onPick: (tab: WorkbenchTab) => void;
}) {
  const cards = [
    { tab: 'review' as const, icon: 'diff' as const, title: labels.review, hint: labels.homeReview },
    { tab: 'files' as const, icon: 'folder' as const, title: labels.files, hint: labels.homeFiles },
    { tab: 'browser' as const, icon: 'globe' as const, title: labels.browser, hint: labels.homeBrowser },
    ...(hasAuxiliary ? [{ tab: 'aux' as const, icon: 'chat' as const, title: labels.auxiliary, hint: labels.homeAuxiliary }] : []),
  ];
  return <div className="pi-workbench__home" role="group" aria-label={labels.homeTitle}>
    <div className="pi-workbench__hometitle">{labels.homeTitle}</div>
    <div className="pi-workbench__homegrid">
      {cards.map(card => (
        <button key={card.tab} className="pi-workbench__homecard" onClick={() => onPick(card.tab)}>
          <span className="pi-workbench__homecardicon"><Icon name={card.icon} size={20} /></span>
          <span className="pi-workbench__homecardname">{card.title}</span>
          <span className="pi-workbench__homecardhint">{card.hint}</span>
        </button>
      ))}
    </div>
  </div>;
}

function Empty({ icon, title, hint }: { icon: 'diff' | 'folder' | 'globe' | 'chat'; title: string; hint: string }) {
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
