import { useEffect, useRef, useState } from 'react';
import { ACCESS_LABELS, ACCESS_MODES, type AccessMode } from '../../shared/access-mode';
import { Icon, type IconName } from '../replica/Icons';
const descriptions: Record<AccessMode, string> = { plan: '只读研究，先给出计划。', ask: '读取自动放行，修改前询问。', autoEdit: '自动编辑项目文件，命令仍需确认。', fullAccess: '允许所有工具调用，不再逐次确认。' };
const names: Record<AccessMode, string> = { plan: 'Plan mode', ask: 'Confirm changes', autoEdit: 'Auto edit', fullAccess: 'Full access' };
const icons: Record<AccessMode, IconName> = { plan: 'brain', ask: 'shield', autoEdit: 'edit-files', fullAccess: 'shield-alert' };
export function AccessModeMenu({ value, disabled, changing, zh, onChange }: { value: AccessMode; disabled: boolean; changing: boolean; zh: boolean; onChange: (mode: AccessMode) => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener('mousedown', close); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', escape); };
  }, [open]);
  return <div className="pi-access" ref={root}>
    <button ref={trigger} className={`pi-access__trigger ${value === 'fullAccess' ? 'pi-access__trigger--full' : ''}`} disabled={disabled || changing} aria-label={zh ? '访问模式' : 'Access mode'} aria-expanded={open} aria-haspopup="menu" title={disabled ? undefined : (zh ? '运行中也可切换，下一个工具调用即生效' : 'Works while a task runs; applies to the next tool call')} onClick={() => setOpen(v => !v)}>
      <Icon name={icons[value]} size={14} /><span>{changing ? (zh ? '正在切换…' : 'Switching…') : zh ? ACCESS_LABELS[value] : names[value]}</span><Icon name="chevron-down" size={12} />
    </button>
    {open && <div className="pi-access__menu" role="menu" aria-label={zh ? '访问模式' : 'Access mode'} onKeyDown={e => {
      const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button'));
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = e.key === 'ArrowDown' ? (index + 1) % buttons.length : e.key === 'ArrowUp' ? (index - 1 + buttons.length) % buttons.length : e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : -1;
      if (next >= 0) { e.preventDefault(); buttons[next].focus(); }
    }}>
      {ACCESS_MODES.map(mode => <button key={mode} role="menuitemradio" aria-checked={value === mode} disabled={disabled || changing} autoFocus={value === mode} onClick={() => { void onChange(mode).then(ok => { if (ok) { setOpen(false); trigger.current?.focus(); } }); }}>
        <Icon name={icons[mode]} size={17} /><span><strong>{zh ? ACCESS_LABELS[mode] : names[mode]}</strong><small>{zh ? descriptions[mode] : ({ plan: 'Read-only research before execution.', ask: 'Ask before changes or commands.', autoEdit: 'Edit project files; ask before commands.', fullAccess: 'Allow tool calls without confirmation.' })[mode]}</small></span>{value === mode && <Icon name="check" size={14} />}
      </button>)}
      <p>{zh ? '作用于工具调用；不是系统沙箱。' : 'Controls tool calls; not an OS sandbox.'}</p>
    </div>}
  </div>;
}
