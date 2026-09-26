import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../replica/Icons';
import { onCloseTransientPopovers } from '../replica/popovers';

export function MemoryMenu({ label, title, children, items, selected, onSelect }: {
  label: string; title: string; children: ReactNode;
  items: { id: string; name: string; detail?: string; icon?: ReactNode }[];
  selected: string; onSelect: (id: string) => void;
}) {
  const [position, setPosition] = useState<{ left: number; top: number }>();
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const id = useId();
  function close(restore = true) { setPosition(undefined); if (restore) trigger.current?.focus(); }
  // 视图切换时收起（fixed+z1000 会穿透设置页覆盖层）。
  useEffect(() => onCloseTransientPopovers(() => close(false)), [position]);
  function show() {
    const rect = trigger.current!.getBoundingClientRect();
    setPosition({ left: Math.max(8, Math.min(rect.left, innerWidth - 288)), top: Math.max(8, Math.min(rect.bottom + 6, innerHeight - 310)) });
  }
  useEffect(() => {
    if (!position) return;
    const buttons = menu.current?.querySelectorAll<HTMLButtonElement>('[role=menuitemradio]');
    (buttons?.[Math.max(0, items.findIndex(i => i.id === selected))])?.focus();
    const outside = (e: PointerEvent) => { if (!menu.current?.contains(e.target as Node) && !trigger.current?.contains(e.target as Node)) close(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
    const reposition = () => close(false);
    const scroll = (e: Event) => { if (!menu.current?.contains(e.target as Node)) close(false); };
    document.addEventListener('scroll', scroll, true);
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', key);
    window.addEventListener('resize', reposition);
    return () => { document.removeEventListener('scroll', scroll, true); document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key); window.removeEventListener('resize', reposition); };
  }, [position]);
  return <>
    <button ref={trigger} type="button" className="pi-memory-menu__trigger" aria-label={label} aria-haspopup="menu" aria-expanded={!!position} aria-controls={position ? id : undefined} onClick={() => position ? close() : show()} onKeyDown={e => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); show(); } }}>{children}<Icon name="chevron-down" size={13} /></button>
    {position && createPortal(<div ref={menu} id={id} className="pi-memory-menu" style={position} role="menu" aria-label={title} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget) && e.relatedTarget !== trigger.current) close(false); }} onKeyDown={e => {
      const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role=menuitemradio]')];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : e.key === 'ArrowDown' ? (index + 1) % buttons.length : e.key === 'ArrowUp' ? (index - 1 + buttons.length) % buttons.length : -1;
      if (next >= 0) { e.preventDefault(); buttons[next]?.focus(); }
      if (e.key === 'Tab') { e.preventDefault(); close(); }
    }}><div className="pi-memory-menu__heading">{title}</div><div className="pi-memory-menu__items">{items.length === 0 && <p role="status">暂无可用选项</p>}{items.map(item => <button type="button" key={item.id} role="menuitemradio" aria-checked={selected === item.id} title={item.detail} onClick={() => { close(); onSelect(item.id); }}>{item.icon ?? <Icon name="folder" size={16} />}<span>{item.name}</span>{selected === item.id && <Icon name="check" size={14} />}</button>)}</div></div>, trigger.current?.closest('.pireplica') ?? document.body)}
  </>;
}
