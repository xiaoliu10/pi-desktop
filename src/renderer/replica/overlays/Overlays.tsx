/**
 * Overlays replica (U06): global search (Cmd/Ctrl+K) and notifications.
 * Purely presentational — selection handlers are demo callbacks.
 */

import { useEffect, useRef } from 'react';
import type { GlobalSearchProps, NotificationItem, NotificationsProps } from '../contracts';
import { Icon } from '../Icons';
import './overlays.css';

export function GlobalSearch(props: GlobalSearchProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!props.open) return;
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [props]);
  if (!props.open) return null;
  const q = props.query.trim().toLowerCase();
  const items = q ? props.items.filter((i) => i.title.toLowerCase().includes(q)) : props.items;

  return (
    <div className="pi-overlay" role="dialog" aria-modal="true" aria-label={props.labels.placeholder} onMouseDown={props.onClose}>
      <div className="pi-search" onMouseDown={(e) => e.stopPropagation()}>
        <div className="pi-search__inputrow">
          <Icon name="search" size={16} />
          <input
            ref={inputRef}
            className="pi-search__input"
            placeholder={props.labels.placeholder}
            value={props.query}
            onChange={(e) => props.onQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') props.onClose();
              if (e.key === 'Enter') {
                const first = items[0];
                if (first) props.onSelect(first);
              }
            }}
            aria-label={props.labels.placeholder}
          />
        </div>
        {!q && (
          <button className="pi-search__row pi-search__row--newtask" onClick={props.onClose}>
            <Icon name="plus-square" size={15} />
            {props.labels.newTask}
          </button>
        )}
        {!q && <div className="pi-search__group">{props.labels.today}</div>}
        <div className="pi-search__list" role="listbox">
          {items.map((item, i) => (
            <button
              key={item.id}
              role="option"
              aria-selected={i === 0}
              className={`pi-search__row ${i === 0 ? 'pi-search__row--sel' : ''}`}
              onClick={() => props.onSelect(item)}
            >
              <Icon name={item.kind === 'message' ? 'chat' : item.kind === 'command' ? 'terminal' : item.kind === 'setting' ? 'settings' : 'chat'} size={14} />
              <span className="pi-search__title">{item.title}</span>
              <span className="pi-search__source">{item.source}</span>
            </button>
          ))}
          {items.length === 0 && <div className="pi-search__empty">{props.labels.noResults}</div>}
        </div>
      </div>
    </div>
  );
}

export function Notifications(props: NotificationsProps) {
  useEffect(() => {
    if (!props.open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [props]);
  if (!props.open) return null;

  const dot: Record<NotificationItem['kind'], string> = {
    info: 'pi-notif__dot pi-notif__dot--info',
    success: 'pi-notif__dot pi-notif__dot--ok',
    error: 'pi-notif__dot pi-notif__dot--bad',
    request: 'pi-notif__dot pi-notif__dot--req',
  };

  return (
    <div className="pi-notifwrap" onMouseDown={props.onClose}>
      <div className="pi-notif" role="dialog" aria-label={props.labels.title} onMouseDown={(e) => e.stopPropagation()}>
        <div className="pi-notif__head">
          <span className="pi-notif__title">{props.labels.title}</span>
          <button className="pi-btn pi-btn--ghost" onClick={props.onMarkAllRead}>
            {props.labels.markAllRead}
          </button>
        </div>
        {props.items.length === 0 && <div className="pi-notif__empty">{props.labels.empty}</div>}
        {props.items.map((n) => (
          <button key={n.id} className="pi-notif__row" onClick={() => props.onSelect(n)}>
            <span className={`${dot[n.kind]} ${n.read ? 'pi-notif__dot--read' : ''}`} />
            <span className="pi-notif__body">
              <span className="pi-notif__rowtitle">
                {n.kind === 'request' && <em className="pi-notif__req">{props.labels.request}</em>}
                {n.title}
              </span>
              {n.body && <span className="pi-notif__rowbody">{n.body}</span>}
            </span>
            <span className="pi-notif__time">{n.time}</span>
          </button>
        ))}
        <div className="pi-notif__note">{props.labels.demoNote}</div>
      </div>
    </div>
  );
}
