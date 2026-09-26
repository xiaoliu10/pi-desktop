import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { Icon } from '../replica/Icons';
import type { TerminalInfo } from '../../shared/terminal';

/**
 * 内置终端面板（复刻 ZCode 侧板终端）：node-pty 会话 + xterm 渲染。
 *
 * 生命周期：面板先打开过一次后就常挂载（open=false 仅隐藏），已开的 shell
 * 会话与滚动缓冲在面板收起/展开之间保持；顶部 tab 可开多个终端，单个 ×
 * 结束该会话，面板 × 只收起面板。
 */

interface TerminalTab {
  info: TerminalInfo;
  dead: boolean;
  exitCode?: number;
}

interface TermEntry {
  term: Terminal;
  fit: FitAddon;
  observer: ResizeObserver;
}

const TERM_FONT = "'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace";

function lightTheme(): Record<string, string> {
  return { background: '#ffffff', foreground: '#24292f', cursor: '#24292f', selectionBackground: '#b8d4f0' };
}

function darkTheme(): Record<string, string> {
  return { background: '#0d1117', foreground: '#c9d1d9', cursor: '#c9d1d9', selectionBackground: '#264f78' };
}

function folderLabel(cwd: string): string {
  return cwd.split('/').filter(Boolean).at(-1) || cwd || '~';
}

function shellLabel(shell: string): string {
  return shell.split('/').at(-1) || shell;
}

export function TerminalPanel({ open, cwd, lang, dark, onClose }: {
  open: boolean;
  cwd?: string;
  lang: 'zh' | 'en';
  dark: boolean;
  onClose: () => void;
}) {
  const zh = lang === 'zh';
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const entries = useRef(new Map<string, TermEntry>());
  const containers = useRef(new Map<string, HTMLDivElement | null>());
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  // open 初次为 true 后保持挂载；关闭仅隐藏，不卸载 xterm 实例。
  const everOpened = useRef(open);
  if (open) everOpened.current = true;

  const spawn = useCallback(async () => {
    try {
      const info = await window.localPi!.terminalCreate({ cwd: cwdRef.current });
      setTabs(prev => [...prev, { info, dead: false }]);
      setActiveId(info.id);
    } catch (error) {
      // 创建失败（极少：超上限）在面板内提示，不打断聊天。
      setTabs(prev => [...prev, { info: { id: `err-${Date.now()}`, shell: '', cwd: '', pid: 0 }, dead: true, exitCode: -1 }]);
      console.error('终端创建失败', error);
    }
  }, []);

  // 首次打开自动建第一个终端。
  useEffect(() => {
    if (!open || tabs.length > 0) return;
    void spawn();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 全局 pty 数据/退出事件 → 写入对应 xterm 实例。
  useEffect(() => {
    const offData = window.localPi!.onTerminalData(({ id, data }) => {
      entries.current.get(id)?.term.write(data);
    });
    const offExit = window.localPi!.onTerminalExit(({ id, exitCode }) => {
      setTabs(prev => prev.map(tab => (tab.info.id === id ? { ...tab, dead: true, exitCode } : tab)));
    });
    return () => { offData(); offExit(); };
  }, []);

  const closeTab = useCallback(async (id: string) => {
    const entry = entries.current.get(id);
    if (entry) {
      entry.observer.disconnect();
      entry.term.dispose();
      entries.current.delete(id);
    }
    containers.current.delete(id);
    if (!tabs.find(tab => tab.info.id === id)?.dead) {
      try { await window.localPi!.terminalKill(id); } catch { /* 会话可能已退出 */ }
    }
    setTabs(prev => {
      const next = prev.filter(tab => tab.info.id !== id);
      setActiveId(current => {
        if (current !== id) return current;
        return next.length ? next[next.length - 1].info.id : null;
      });
      return next;
    });
    if (!tabs.some(tab => tab.info.id !== id)) onClose();
  }, [tabs, onClose]);

  // 活跃 tab：懒创建 xterm 实例并挂到容器；应用主题。
  useEffect(() => {
    if (!activeId || !everOpened.current) return;
    if (entries.current.has(activeId)) return;
    const el = containers.current.get(activeId);
    if (!el) return;
    const term = new Terminal({
      fontFamily: TERM_FONT,
      fontSize: 12.5,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 5000,
      theme: dark ? darkTheme() : lightTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    try { fit.fit(); } catch { /* 容器尚未布局时忽略 */ }
    term.onData(data => { void window.localPi!.terminalWrite(activeId, data); });
    term.onResize(({ cols, rows }) => { void window.localPi!.terminalResize(activeId, cols, rows); });
    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch { /* display:none 时 fit 会抛错，忽略 */ }
    });
    observer.observe(el);
    entries.current.set(activeId, { term, fit, observer });
    return () => { /* 实例与 tab 同生命周期，这里不做清理 */ };
  }, [activeId, dark]);

  // 主题切换时更新已开实例的配色。
  useEffect(() => {
    for (const { term } of entries.current.values()) term.options.theme = dark ? darkTheme() : lightTheme();
  }, [dark]);

  const active = tabs.find(tab => tab.info.id === activeId);
  const visible = everOpened.current;

  return (
    <aside className="pi-terminal-panel" style={{ display: open ? 'flex' : 'none', '--pi-terminal-bg': (dark ? darkTheme() : lightTheme()).background } as CSSProperties} aria-label={zh ? '内置终端' : 'Terminal'}>
      <header className="pi-terminal-panel__tabs" role="tablist">
        <span className="pi-terminal-panel__brand"><Icon name="terminal" size={13} />{zh ? '终端' : 'Terminal'}</span>
        {tabs.map(tab => (
          <div key={tab.info.id} className={`pi-terminal-panel__tab ${tab.info.id === activeId ? 'pi-terminal-panel__tab--on' : ''} ${tab.dead ? 'pi-terminal-panel__tab--dead' : ''}`}>
            <button role="tab" aria-selected={tab.info.id === activeId} title={tab.info.cwd} onClick={() => setActiveId(tab.info.id)}>
              {tab.dead ? '× ' : ''}{folderLabel(tab.info.cwd) || (zh ? '已退出' : 'exited')}
            </button>
            <button className="pi-terminal-panel__tabclose" aria-label={zh ? '关闭终端' : 'Close terminal'} onClick={() => void closeTab(tab.info.id)}>
              <Icon name="x" size={11} />
            </button>
          </div>
        ))}
        <button className="pi-iconbtn" aria-label={zh ? '新建终端' : 'New terminal'} title={zh ? '新建终端' : 'New terminal'} onClick={() => void spawn()}>
          <Icon name="plus" size={14} />
        </button>
        <button className="pi-iconbtn pi-terminal-panel__close" aria-label={zh ? '收起终端面板' : 'Hide terminal panel'} title={zh ? '收起' : 'Hide'} onClick={onClose}>
          <Icon name="x" size={15} />
        </button>
      </header>
      <div className="pi-terminal-panel__body">
        {tabs.map(tab => (
          <div
            key={tab.info.id}
            ref={el => { containers.current.set(tab.info.id, el); }}
            className="pi-terminal-panel__term"
            style={{ display: tab.info.id === activeId ? 'block' : 'none' }}
          />
        ))}
        {visible && active?.dead && (
          <div className="pi-terminal-panel__hint" role="status">
            {zh ? `进程已退出（code ${active.exitCode ?? '?'}）。点 + 新开一个终端。` : `Process exited (code ${active.exitCode ?? '?'}). Use + to start a new terminal.`}
          </div>
        )}
        {visible && tabs.length === 0 && <div className="pi-terminal-panel__hint">{zh ? '暂无终端会话。' : 'No terminal sessions.'}</div>}
      </div>
    </aside>
  );
}
