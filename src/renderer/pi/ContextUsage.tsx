import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface ContextUsage { tokens: number | null; contextWindow: number; percent: number | null }

export function ContextUsageDetails({ usage, zh, model }: { usage?: ContextUsage; zh: boolean; model?: string }) {
  const known = usage && Number.isFinite(usage.tokens) && usage.tokens !== null && usage.tokens >= 0 && usage.contextWindow > 0;
  const percent = known ? usage.tokens! / usage.contextWindow * 100 : null;
  const format = (n: number) => n.toLocaleString(zh ? 'zh-CN' : 'en-US');
  return <>
    <header className="pi-context-popover__heading"><strong>{zh ? '上下文容量' : 'Context capacity'}</strong><span>{percent === null ? '—' : `${percent.toFixed(1)}%`}</span></header>
    {model && <p className="pi-context-popover__model">{model}</p>}
    <div className="pi-context-popover__bar" role="progressbar" aria-label={zh ? '上下文占用' : 'Context usage'} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent === null ? undefined : Math.min(100, percent)}><span style={{ width: `${Math.min(100, percent ?? 0)}%` }} /></div>
    <dl className="pi-context-popover__stats">
      <div><dt>{zh ? '已使用' : 'Used'}</dt><dd>{known ? `${format(usage.tokens!)} tokens` : (zh ? '更新中 / 暂无数据' : 'Updating / unavailable')}</dd></div>
      <div><dt>{zh ? '窗口容量' : 'Capacity'}</dt><dd>{usage?.contextWindow ? `${format(usage.contextWindow)} tokens` : '—'}</dd></div>
      <div><dt>{zh ? '剩余容量' : 'Remaining'}</dt><dd>{known ? `${format(Math.max(0, usage.contextWindow - usage.tokens!))} tokens` : '—'}</dd></div>
    </dl>
    <p className="pi-context-popover__note">{zh ? '当前会话的上下文估算，非累计 token 消耗。' : 'Current session context estimate, not cumulative token usage.'}</p>
    <section className="pi-context-popover__quota"><strong>Coding Plan {zh ? '限额' : 'quota'}</strong><p>{zh ? '尚未接入供应商的套餐用量接口，无法查询限额。上下文剩余量不代表套餐余额。' : 'Provider quota reporting is not connected. Context capacity is not your plan balance.'}</p></section>
  </>;
}

/** A real hover/focus card, rendered at the app root to escape composer clipping. */
export function ContextUsageChip({ usage, zh, compact, model }: { usage?: ContextUsage; zh: boolean; compact?: boolean; model?: string }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>();
  const id = useId();
  const cancelClose = () => { clearTimeout(closeTimer.current); };
  const show = () => { cancelClose(); setOpen(true); };
  const hide = () => { cancelClose(); setOpen(false); };
  const scheduleClose = () => { cancelClose(); closeTimer.current = setTimeout(() => setOpen(false), 160); };
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  useLayoutEffect(() => {
    if (!open) return;
    const positionCard = () => {
      if (!trigger.current || !panel.current) return;
      const anchor = trigger.current.getBoundingClientRect();
      const card = panel.current.getBoundingClientRect();
      setPosition({ left: Math.max(8, Math.min(anchor.right - card.width, window.innerWidth - card.width - 8)), top: Math.max(8, anchor.top - card.height - 10) });
    };
    positionCard();
    window.addEventListener('resize', positionCard);
    window.addEventListener('scroll', positionCard, true);
    return () => { window.removeEventListener('resize', positionCard); window.removeEventListener('scroll', positionCard, true); };
  }, [open, usage, model, zh]);
  useEffect(() => {
    if (!open) return;
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); hide(); } };
    const outside = (event: MouseEvent) => { if (!trigger.current?.contains(event.target as Node) && !panel.current?.contains(event.target as Node)) hide(); };
    document.addEventListener('keydown', key);
    document.addEventListener('mousedown', outside);
    return () => { document.removeEventListener('keydown', key); document.removeEventListener('mousedown', outside); };
  }, [open]);
  const percent = usage?.tokens != null && usage.contextWindow > 0 ? usage.tokens / usage.contextWindow * 100 : null;
  const pct = Math.max(0, Math.min(100, percent ?? 0));
  const cls = `pi-context-chip${pct >= 95 ? ' pi-context-chip--danger' : pct >= 80 ? ' pi-context-chip--warn' : ''}${compact ? ' pi-context-chip--compact' : ''}`;
  const host = trigger.current?.closest('.pireplica');
  return <>
    <button type="button" ref={trigger} className={cls} aria-label={zh ? '查看上下文用量' : 'View context usage'} aria-expanded={open} aria-describedby={open ? id : undefined} onMouseEnter={show} onMouseLeave={scheduleClose} onFocus={show} onBlur={scheduleClose} onClick={show}>
      <svg viewBox="0 0 16 16" width="14" height="14" className="pi-context-chip__ring" aria-hidden="true"><circle cx="8" cy="8" r="6" className="pi-context-chip__track" /><circle cx="8" cy="8" r="6" className="pi-context-chip__value" strokeDasharray={`${pct * 0.377} 37.7`} transform="rotate(-90 8 8)" /></svg>
      {!compact && <span>{zh ? '上下文' : 'Context'} {percent === null ? '—' : `${percent.toFixed(1)}%`}</span>}
    </button>
    {open && host && createPortal(<div id={id} ref={panel} role="tooltip" className="pi-context-popover" style={position} onMouseEnter={cancelClose} onMouseLeave={scheduleClose}><ContextUsageDetails usage={usage} zh={zh} model={model} /></div>, host)}
  </>;
}
