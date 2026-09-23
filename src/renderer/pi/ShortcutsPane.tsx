/**
 * Shortcuts settings pane (ZCode-style table): 命令 / 按键绑定 / 作用域 / 操作.
 * Data layer comes from SettingsFeatures' snapshot — bindings are the real
 * DesktopPreferences.shortcuts consumed by the app-wide hotkey handler, and
 * saves go through saveDesktopSettings (main process validates format and
 * conflicts). Recording captures the next keystroke; Escape cancels.
 */

import { useEffect, useState } from 'react';
import {
  DEFAULT_SHORTCUTS,
  validShortcut,
  type SettingsSnapshot,
  type ShortcutAction,
} from '../../shared/settings';
import { Icon } from '../replica/Icons';

export const actionNames: Record<ShortcutAction, string> = {
  search: '全局搜索',
  newSession: '新建会话',
  settings: '打开设置',
  workbench: '显示 / 隐藏工作面板',
  sidebar: '折叠 / 展开侧栏',
  stop: '停止当前任务',
};

const KEY_LABELS: Record<string, string> = {
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  enter: '↵',
  tab: '⇥',
  escape: '⎋',
};

/** Split a binding like "Mod+Shift+N" into display keys ["⌘","⇧","N"]. */
export function bindingKeys(binding: string, mac: boolean = typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent)): string[] {
  const parts = binding.split('+');
  const key = parts.pop();
  if (key === undefined) return [binding];
  const out: string[] = [];
  for (const part of parts) {
    const p = part.toLowerCase();
    if (p === 'mod') out.push(mac ? '⌘' : 'Ctrl');
    else if (p === 'shift') out.push(mac ? '⇧' : 'Shift');
    else if (p === 'alt') out.push(mac ? '⌥' : 'Alt');
    else out.push(part);
  }
  const lower = key.toLowerCase();
  out.push(KEY_LABELS[lower] ?? (key.length === 1 ? key.toUpperCase() : key));
  return out;
}

/** Convert a captured keystroke to a binding string; null when not usable. */
export function eventToBinding(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): string | null {
  if (!(event.metaKey || event.ctrlKey)) return null;
  const raw = event.key;
  const key = /^[a-z]$/i.test(raw) ? raw.toUpperCase() : /^[0-9,./]$/.test(raw) ? raw : /^F(?:[1-9]|1[0-2])$/.test(raw) ? raw : null;
  if (!key) return null;
  const parts = ['Mod'];
  if (event.shiftKey) parts.push('Shift');
  if (event.altKey) parts.push('Alt');
  parts.push(key);
  const binding = parts.join('+');
  return validShortcut(binding) ? binding : null;
}

interface ShortcutsPaneProps {
  data: SettingsSnapshot;
  query: string;
  busy: boolean;
  act: (fn: () => Promise<unknown>, message?: string) => Promise<void>;
}

export function ShortcutsPane({ data, query, busy, act }: ShortcutsPaneProps) {
  const api = () => window.localPi;
  const bindings = data.preferences.shortcuts;
  const [recording, setRecording] = useState<ShortcutAction | null>(null);
  const [rowError, setRowError] = useState<string | undefined>();

  const q = query.trim().toLowerCase();
  const actions = (Object.keys(DEFAULT_SHORTCUTS) as ShortcutAction[]).filter(
    (a) => !q || actionNames[a].toLowerCase().includes(q) || bindings[a].toLowerCase().includes(q),
  );

  useEffect(() => {
    if (!recording) return;
    document.body.dataset.shortcutRecording = '1';
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      if (e.key === 'Escape') {
        setRecording(null);
        setRowError(undefined);
        return;
      }
      const next = eventToBinding(e);
      if (!next) {
        setRowError('需要 ⌘/Ctrl 组合（可加 Shift/Alt），例如 ⌘⇧K');
        return;
      }
      const conflict = (Object.keys(bindings) as ShortcutAction[]).find(
        (a) => a !== recording && bindings[a].toLowerCase() === next.toLowerCase(),
      );
      if (conflict) {
        setRowError(`与「${actionNames[conflict]}」冲突，换一个组合`);
        return;
      }
      setRecording(null);
      setRowError(undefined);
      void act(() => api().saveDesktopSettings({ shortcuts: { ...bindings, [recording]: next } }), '快捷键已保存并生效');
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      delete document.body.dataset.shortcutRecording;
      document.removeEventListener('keydown', onKey, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, bindings, act]);

  return (
    <section className="pi-features__card pi-shortcuts">
      <p>Mod 表示 macOS 的 Command 或其他平台的 Ctrl。点击 ✏️ 后按下新的组合即保存生效；发送使用 Enter，换行使用 Shift+Enter。</p>
      <table className="pi-shortcuts__table">
        <thead>
          <tr>
            <th>命令</th>
            <th>按键绑定</th>
            <th>作用域</th>
            <th aria-label="操作" />
          </tr>
        </thead>
        <tbody>
          {actions.map((a) => (
            <tr key={a} className={recording === a ? 'pi-shortcuts__row--rec' : undefined}>
              <td>
                <div className="pi-shortcuts__cmd">
                  {actionNames[a]}
                  {bindings[a] !== DEFAULT_SHORTCUTS[a] && <span className="pi-shortcuts__custom">已自定义</span>}
                </div>
              </td>
              <td>
                {recording === a ? (
                  <>
                    <span className="pi-shortcuts__recording">按下新的按键组合…（Esc 取消）</span>
                    {rowError && <div className="pi-shortcuts__err" role="alert">{rowError}</div>}
                  </>
                ) : (
                  <span className="pi-shortcuts__keys">
                    {bindingKeys(bindings[a]).map((k, i) => (
                      <kbd key={i} className="pi-kbd">
                        {k}
                      </kbd>
                    ))}
                  </span>
                )}
              </td>
              <td>
                <span className="pi-shortcuts__scope">全局</span>
              </td>
              <td>
                <div className="pi-shortcuts__ops">
                  <button
                    className="pi-iconbtn"
                    aria-label={`修改「${actionNames[a]}」快捷键`}
                    title="修改"
                    disabled={busy}
                    onClick={() => {
                      setRowError(undefined);
                      setRecording(recording === a ? null : a);
                    }}
                  >
                    <Icon name="pencil" size={14} />
                  </button>
                  <button
                    className="pi-iconbtn"
                    aria-label={`恢复「${actionNames[a]}」默认`}
                    title="恢复默认"
                    disabled={busy || bindings[a] === DEFAULT_SHORTCUTS[a]}
                    onClick={() => {
                      setRecording(null);
                      setRowError(undefined);
                      void act(() => api().saveDesktopSettings({ shortcuts: { ...bindings, [a]: DEFAULT_SHORTCUTS[a] } }), '已恢复该快捷键的默认值');
                    }}
                  >
                    <Icon name="refresh" size={14} />
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!actions.length && <div className="pi-shortcuts__empty">没有匹配的快捷键。</div>}
      <div className="pi-shortcuts__foot">
        <button
          className="pi-btn pi-btn--outline"
          disabled={busy}
          onClick={() => {
            setRecording(null);
            setRowError(undefined);
            void act(() => api().saveDesktopSettings({ shortcuts: DEFAULT_SHORTCUTS }), '已恢复默认快捷键');
          }}
        >
          <Icon name="refresh" size={14} />
          全部恢复默认
        </button>
      </div>
    </section>
  );
}
