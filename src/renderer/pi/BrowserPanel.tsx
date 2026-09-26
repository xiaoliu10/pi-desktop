/**
 * 工作台内置浏览器（复刻 ZCode 右侧浏览器面板）：多标签页 + 地址栏 + 视口尺寸选择，
 * 基于 Electron <webview> 渲染任意网页。
 *
 * 保活策略（与 TerminalPanel 一致）：组件由 WorkbenchPanel 的稳定插槽承载，
 * 切换工作台 tab / 收起面板仅 display:none，webview 不卸载，页面状态不丢。
 *
 * 安全边界：
 * - webview 只设置 src —— 不挂 preload、不开 nodeintegration / allowpopups，
 *   任意网页拿不到主窗口的 window.localPi 本地 IPC；
 * - 地址栏输入经 normalizeUrl 归一化，只放行 http/https，file:/javascript:/data: 等
 *   在渲染层直接拒绝并提示；主进程 web-contents-created 的 will-navigate 守卫兜底；
 * - 外链（target=_blank / window.open）由主进程 setWindowOpenHandler 一律 deny 并转交
 *   系统默认浏览器（仅 http/https），绝不新建带权限的 Electron 窗口。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { WebviewTag } from 'electron';
import { Icon } from '../replica/Icons';
import type { BrowserLabels } from '../replica/contracts';
import { normalizeUrl, VIEWPORTS, viewportById } from '../replica/workbench/browser-utils';
import '../replica/workbench/workbench.css';

interface BrowserTab {
  id: string;
  /** 仅地址栏提交/重试时变化，驱动 <webview src>；did-navigate 不回写，避免重定向循环加载。 */
  srcUrl: string | null;
  /** 当前实际 URL（did-navigate 更新，含站内跳转/重定向）。 */
  url: string | null;
  input: string;
  title: string;
  favicon: string | null;
  loading: boolean;
  canBack: boolean;
  canForward: boolean;
  /** 主框架加载失败描述（did-fail-load，忽略 ERR_ABORTED）。 */
  error: string | null;
  /** 地址栏输入被拒绝的提示（协议拦截 / 无效 URL）。 */
  notice: string | null;
}

const VIEWPORT_KEY = 'pi.browserViewport';

function hostOf(url: string | null): string {
  if (!url) return '';
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function tabLabel(tab: BrowserTab, untitled: string): string {
  return tab.title || hostOf(tab.url) || untitled;
}

export function BrowserPanel({ labels }: { labels: BrowserLabels }) {
  const [tabs, setTabs] = useState<BrowserTab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [viewport, setViewport] = useState<string>(() => {
    try {
      return localStorage.getItem(VIEWPORT_KEY) || 'fit';
    } catch {
      return 'fit';
    }
  });
  const [stageSize, setStageSize] = useState<{ w: number; h: number } | null>(null);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const webviews = useRef(new Map<string, WebviewTag>());
  const refCbs = useRef(new Map<string, (el: WebviewTag | null) => void>());
  const seq = useRef(0);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const preset = viewportById(viewport);
  const active = tabs.find((tab) => tab.id === activeId) ?? null;

  const patch = useCallback((id: string, part: Partial<BrowserTab>) => {
    setTabs((prev) => prev.map((tab) => (tab.id === id ? { ...tab, ...part } : tab)));
  }, []);

  // 每个 webview 元素只接线一次（ref 回调缓存保证 mount/unmount 才触发 attach）。
  const attach = useCallback(
    (id: string, el: WebviewTag | null) => {
      if (!el) {
        webviews.current.delete(id);
        return;
      }
      webviews.current.set(id, el);
      const flagged = el as WebviewTag & { __piBrowserWired?: boolean };
      if (flagged.__piBrowserWired) return;
      flagged.__piBrowserWired = true;
      const syncNav = () => {
        patch(id, {
          canBack: typeof el.canGoBack === 'function' ? el.canGoBack() : false,
          canForward: typeof el.canGoForward === 'function' ? el.canGoForward() : false,
        });
      };
      el.addEventListener('did-start-loading', () => patch(id, { loading: true }));
      el.addEventListener('did-stop-loading', () => {
        patch(id, { loading: false });
        syncNav();
      });
      el.addEventListener('did-navigate', (event) => {
        const { url } = event as unknown as { url: string };
        patch(id, { url, input: url, error: null });
        syncNav();
      });
      el.addEventListener('did-navigate-in-page', (event) => {
        const e = event as unknown as { url: string; isMainFrame: boolean };
        if (!e.isMainFrame) return;
        patch(id, { url: e.url, input: e.url });
        syncNav();
      });
      el.addEventListener('page-title-updated', (event) => {
        patch(id, { title: (event as unknown as { title?: string }).title ?? '' });
      });
      el.addEventListener('page-favicon-updated', (event) => {
        const { favicons } = event as unknown as { favicons?: string[] };
        patch(id, { favicon: favicons?.[0] ?? null });
      });
      el.addEventListener('did-fail-load', (event) => {
        const e = event as unknown as { errorCode: number; errorDescription: string; isMainFrame: boolean };
        if (!e.isMainFrame || e.errorCode === -3) return; // -3 = ERR_ABORTED：被新导航打断，不算失败
        patch(id, { error: e.errorDescription || `error ${e.errorCode}`, loading: false });
      });
    },
    [patch],
  );

  const refFor = (id: string) => {
    let cb = refCbs.current.get(id);
    if (!cb) {
      cb = (el) => attach(id, el);
      refCbs.current.set(id, cb);
    }
    return cb;
  };

  const newTab = useCallback(() => {
    const id = `tab-${++seq.current}`;
    setTabs((prev) => [
      ...prev,
      { id, srcUrl: null, url: null, input: '', title: '', favicon: null, loading: false, canBack: false, canForward: false, error: null, notice: null },
    ]);
    setActiveId(id);
    window.setTimeout(() => inputRef.current?.focus(), 30);
  }, []);

  const closeTab = useCallback((id: string) => {
    refCbs.current.delete(id);
    setTabs((prev) => {
      const index = prev.findIndex((tab) => tab.id === id);
      const next = prev.filter((tab) => tab.id !== id);
      setActiveId((current) => {
        if (current !== id) return current;
        return next[Math.min(index, next.length - 1)]?.id ?? null;
      });
      return next;
    });
  }, []);

  const navigate = useCallback(
    (id: string, raw: string) => {
      const result = normalizeUrl(raw);
      if (!result.ok) {
        if (result.reason !== 'empty') {
          patch(id, { notice: result.reason === 'protocol' ? labels.blockedProtocol : labels.invalidUrl });
        }
        return;
      }
      const current = tabsRef.current.find((tab) => tab.id === id);
      const el = webviews.current.get(id);
      const same = Boolean(current?.srcUrl && current.srcUrl === result.url);
      patch(id, {
        url: result.url,
        input: result.url,
        notice: null,
        error: null,
        loading: true,
        ...(same ? {} : { srcUrl: result.url }),
      });
      if (same && el && typeof el.loadURL === 'function') {
        // src 属性未变时 React 不会触发导航（同地址重输），手动 loadURL。
        void el.loadURL(result.url).catch(() => patch(id, { loading: false }));
      }
    },
    [labels, patch],
  );

  const retry = useCallback(
    (id: string) => {
      const current = tabsRef.current.find((tab) => tab.id === id);
      if (!current?.srcUrl) return;
      const el = webviews.current.get(id);
      patch(id, { error: null, loading: true });
      if (el && typeof el.loadURL === 'function') {
        void el.loadURL(current.srcUrl).catch(() => patch(id, { loading: false }));
      }
    },
    [patch],
  );

  const goBack = (id: string) => {
    const el = webviews.current.get(id);
    if (el && typeof el.canGoBack === 'function' && el.canGoBack()) el.goBack();
  };
  const goForward = (id: string) => {
    const el = webviews.current.get(id);
    if (el && typeof el.canGoForward === 'function' && el.canGoForward()) el.goForward();
  };
  const reloadOrStop = (id: string) => {
    const tab = tabsRef.current.find((t) => t.id === id);
    const el = webviews.current.get(id);
    if (!el || !tab?.srcUrl) return;
    if (tab.loading && typeof el.stop === 'function') el.stop();
    else if (typeof el.reload === 'function') el.reload();
  };

  // 视口选择持久化（仅本机偏好）。
  useEffect(() => {
    try {
      localStorage.setItem(VIEWPORT_KEY, viewport);
    } catch {
      /* 存储不可用时仅影响本次会话 */
    }
  }, [viewport]);

  // 「适应窗口」模式下展示当前实际视口尺寸（对齐 ZCode 的 宽 × 高 显示）。
  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setStageSize({ w: Math.round(rect.width), h: Math.round(rect.height) });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="pi-browser">
      <div className="pi-browser__tabs" role="tablist">
        {tabs.map((tab) => (
          <div key={tab.id} className={`pi-browser__tab ${tab.id === activeId ? 'pi-browser__tab--on' : ''}`}>
            <button
              role="tab"
              aria-selected={tab.id === activeId}
              className="pi-browser__tabmain"
              title={tab.url ?? labels.untitled}
              onClick={() => setActiveId(tab.id)}
            >
              {tab.loading ? (
                <Icon name="loader" size={12} className="pi-browser__spin" />
              ) : tab.favicon ? (
                <img className="pi-browser__favicon" src={tab.favicon} alt="" />
              ) : (
                <Icon name="globe" size={12} />
              )}
              <span className="pi-browser__tabtitle">{tabLabel(tab, labels.untitled)}</span>
            </button>
            <button
              className="pi-browser__tabclose"
              aria-label={`${labels.closeTab}: ${tabLabel(tab, labels.untitled)}`}
              title={labels.closeTab}
              onClick={() => closeTab(tab.id)}
            >
              <Icon name="x" size={11} />
            </button>
          </div>
        ))}
        <button className="pi-iconbtn pi-browser__newtab" aria-label={labels.newTab} title={labels.newTab} onClick={newTab}>
          <Icon name="plus" size={14} />
        </button>
      </div>

      <form
        className="pi-browser__bar"
        onSubmit={(event) => {
          event.preventDefault();
          if (active) navigate(active.id, active.input);
        }}
      >
        <button type="button" className="pi-iconbtn" disabled={!active?.canBack} aria-label={labels.back} title={labels.back} onClick={() => active && goBack(active.id)}>
          <Icon name="arrow-left" size={14} />
        </button>
        <button type="button" className="pi-iconbtn" disabled={!active?.canForward} aria-label={labels.forward} title={labels.forward} onClick={() => active && goForward(active.id)}>
          <Icon name="arrow-right" size={14} />
        </button>
        <button
          type="button"
          className="pi-iconbtn"
          disabled={!active?.srcUrl}
          aria-label={active?.loading ? labels.stop : labels.reload}
          title={active?.loading ? labels.stop : labels.reload}
          onClick={() => active && reloadOrStop(active.id)}
        >
          <Icon name={active?.loading ? 'x' : 'refresh'} size={14} />
        </button>
        <input
          ref={inputRef}
          className="pi-browser__address"
          value={active?.input ?? ''}
          disabled={!active}
          placeholder={labels.addressPlaceholder}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          inputMode="url"
          onChange={(event) => active && patch(active.id, { input: event.target.value, notice: null })}
          onFocus={(event) => event.target.select()}
        />
        <button type="submit" className="pi-browser__go" disabled={!active}>
          {labels.go}
        </button>
      </form>
      {active?.notice && (
        <div className="pi-browser__notice" role="alert">
          {active.notice}
        </div>
      )}

      <div className="pi-browser__viewport">
        <span className="pi-browser__size">
          {preset.width ? `${preset.width} × ${preset.height}` : stageSize ? `${stageSize.w} × ${stageSize.h}` : '—'}
        </span>
        <select className="pi-browser__viewportselect" value={viewport} aria-label={labels.viewportSize} title={labels.viewportSize} onChange={(event) => setViewport(event.target.value)}>
          <option value="fit">{labels.fitWindow}</option>
          {VIEWPORTS.filter((v) => v.width).map((v) => (
            <option key={v.id} value={v.id}>
              {v.width} × {v.height}
            </option>
          ))}
        </select>
      </div>

      <div className={`pi-browser__stage ${preset.width ? 'pi-browser__stage--fixed' : ''}`} ref={stageRef}>
        {tabs.map(
          (tab) =>
            tab.srcUrl && (
              <div
                key={tab.id}
                className="pi-browser__frame"
                style={{
                  display: tab.id === activeId ? 'block' : 'none',
                  ...(preset.width ? { width: preset.width, height: preset.height } : {}),
                }}
              >
                <webview ref={refFor(tab.id)} src={tab.srcUrl} className="pi-browser__view" />
                {tab.error && tab.id === activeId && (
                  <div className="pi-browser__error" role="alert">
                    <span className="pi-workbench__emptyicon">
                      <Icon name="warning" size={18} />
                    </span>
                    <div className="pi-browser__errortitle">{labels.loadFailed}</div>
                    <div className="pi-browser__errordetail">{tab.error}</div>
                    <button type="button" className="pi-browser__btn" onClick={() => retry(tab.id)}>
                      <Icon name="refresh" size={13} />
                      {labels.retry}
                    </button>
                  </div>
                )}
              </div>
            ),
        )}
        {active && !active.srcUrl && (
          <div className="pi-browser__start">
            <Icon name="globe" size={16} />
            <span>{labels.startHint}</span>
          </div>
        )}
        {!active && (
          <div className="pi-workbench__empty">
            <span className="pi-workbench__emptyicon">
              <Icon name="globe" size={18} />
            </span>
            <div className="pi-workbench__emptytitle">{labels.emptyTitle}</div>
            <div className="pi-workbench__emptyhint">{labels.emptyHint}</div>
            <button type="button" className="pi-browser__btn" onClick={newTab}>
              <Icon name="plus" size={13} />
              {labels.newTab}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
