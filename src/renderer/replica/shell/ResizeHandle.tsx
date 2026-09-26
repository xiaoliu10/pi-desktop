import { useCallback, useRef, useState } from 'react';

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Width state persisted in localStorage; returns [width, update, reset]. */
export function usePanelWidth(key: string, fallback: number, min: number, max: number): [number, (w: number) => void, () => void] {
  const [width, setWidth] = useState(() => {
    const raw = Number(localStorage.getItem(key));
    return Number.isFinite(raw) && raw >= min && raw <= max ? Math.round(raw) : fallback;
  });
  const update = useCallback((w: number) => { setWidth(Math.round(w)); localStorage.setItem(key, String(Math.round(w))); }, [key]);
  const reset = useCallback(() => { setWidth(fallback); localStorage.removeItem(key); }, [fallback, key]);
  return [width, update, reset];
}

export interface ResizeHandleProps {
  /** Which edge of the neighbouring panel the handle sits on: drag right grows a left panel, drag left grows a right panel.
   *  'bottom' docks under the content: drag up grows the panel below, drag down shrinks it. */
  side: 'left' | 'right' | 'bottom';
  width: number;
  min: number;
  max: number;
  /** Persisted by the owner via localStorage; live updates during the drag. */
  onChange: (width: number) => void;
  onReset: () => void;
  label: string;
}

/** Col-resize strip between panels: drag to set width, double-click to reset.
 * Document-level listeners make the drag survive the pointer leaving the strip. */
export function ResizeHandle(props: ResizeHandleProps) {
  // Latest values without re-binding listeners mid-drag.
  const state = useRef(props);
  state.current = props;
  const dragging = useRef<{ startX: number; startY: number; startWidth: number } | null>(null);

  const onMouseDown = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    dragging.current = { startX: event.clientX, startY: event.clientY, startWidth: state.current.width };
    const grew = state.current.side === 'left' ? 1 : -1;
    const horizontal = state.current.side !== 'bottom';
    const onMove = (e: MouseEvent) => {
      const start = dragging.current;
      if (!start) return;
      const delta = horizontal ? e.clientX - start.startX : e.clientY - start.startY;
      const next = start.startWidth + grew * delta;
      state.current.onChange(Math.min(state.current.max, Math.max(state.current.min, next)));
    };
    const onUp = () => {
      dragging.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.body.style.cursor = horizontal ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);

  return (
    <div
      className={`pi-resizehandle pi-resizehandle--${props.side}`}
      role="separator"
      aria-orientation={props.side === 'bottom' ? 'horizontal' : 'vertical'}
      aria-label={props.label}
      title={`${props.label}（拖动调整，双击复位）`}
      onMouseDown={onMouseDown}
      onDoubleClick={props.onReset}
    />
  );
}
