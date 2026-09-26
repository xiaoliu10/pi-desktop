/**
 * Unified linear icon set for the replica UI (U01).
 * All icons are 24-viewBox stroke SVGs using currentColor so themes apply
 * automatically. MascotMark is an independent approximate redraw of the
 * reference mascot (documented in docs/ui-reference-baseline.md §5).
 */

import type { CSSProperties, ReactNode } from 'react';

export type IconName =
  | 'expand-diagonal' | 'git-commit' | 'file-plus' | 'pin' | 'git-branch' | 'calendar-clock' | 'grid' | 'plus-circle' | 'sidebar' | 'plus' | 'plus-square' | 'search' | 'panel' | 'settings' | 'plug'
  | 'bell' | 'chevron-down' | 'chevron-right' | 'chevron-left' | 'folder' | 'chat'
  | 'send' | 'stop' | 'shield' | 'shield-alert' | 'attach' | 'bot' | 'sparkle' | 'brain' | 'sliders' | 'keyboard'
  | 'book' | 'stack' | 'box' | 'download' | 'archive' | 'info' | 'instructions'
  | 'file' | 'code' | 'globe' | 'diff' | 'check' | 'check-circle' | 'x' | 'warning'
  | 'refresh' | 'download-cloud' | 'link' | 'trash' | 'pencil' | 'circle' | 'more' | 'copy'
  | 'globe-scope' | 'edit-files' | 'read-files' | 'network' | 'terminal' | 'switch' | 'grip' | 'arrow-up' | 'panel-right'
  | 'smartphone' | 'loader' | 'notepad' | 'arrow-right' | 'arrow-left' | 'mic';

const paths: Record<IconName, ReactNode> = {
  'expand-diagonal': <><path d="M14 3h7v7M21 3l-7 7M10 21H3v-7M3 21l7-7"/></>,
  grip: <><circle cx="9" cy="6" r="1.2"/><circle cx="15" cy="6" r="1.2"/><circle cx="9" cy="12" r="1.2"/><circle cx="15" cy="12" r="1.2"/><circle cx="9" cy="18" r="1.2"/><circle cx="15" cy="18" r="1.2"/></>,
  'arrow-up': <><path d="M12 19V5M5 12l7-7 7 7"/></>,
  'git-commit': <><circle cx="12" cy="12" r="3"/><path d="M3 12h6m6 0h6"/></>,
  'file-plus': <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M12 12v6M9 15h6"/></>,
  pin: <><path d="m16 3 5 5-4 1-4 4v4l-2 2-6-6 2-2h4l4-4 1-4Z"/><path d="m8 16-5 5"/></>,
  'git-branch': <><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M6 7v10M18 7a9 9 0 0 1-9 9H6"/></>,
  'plus-circle': <><circle cx="12" cy="12" r="9" /><path d="M12 8v8M8 12h8" /></>,
  grid: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
  'calendar-clock': <><path d="M8 3v4M16 3v4M3 10h10M10 21H6a3 3 0 0 1-3-3V7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4" /><circle cx="16" cy="17" r="5" /><path d="M16 14v3l2 1" /></>,
  sidebar: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M9.5 4v16" />
      <path d="M5.5 8h1.5M5.5 11h1.5" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  'plus-square': (
    <>
      <rect x="4" y="4" width="16" height="16" rx="3.5" />
      <path d="M12 9v6M9 12h6" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </>
  ),
  panel: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M14.5 4v16" />
      <path d="M11.5 10L9 12.5l2.5 2.5" />
    </>
  ),
  'panel-right': (
    <>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M14.5 4v16" />
      <path d="M9.5 10l2.5 2.5L9.5 15" />
    </>
  ),
  smartphone: (
    <>
      <rect x="7" y="2" width="10" height="20" rx="2.5" />
      <path d="M11 18h2" />
    </>
  ),
  loader: <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />,
  mic: <><path d="M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3Z"/><path d="M19 11a7 7 0 0 1-14 0"/><path d="M12 18v3"/></>,
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </>
  ),
  plug: (
    <>
      <path d="M9 3.5V8M15 3.5V8" />
      <path d="M6.5 8h11v3.5a5.5 5.5 0 0 1-11 0V8Z" />
      <path d="M12 17v3.5" />
    </>
  ),
  bell: (
    <>
      <path d="M6 10a6 6 0 0 1 12 0c0 3.5 1 4.8 1.8 5.6.4.4.1 1.1-.5 1.1H4.7c-.6 0-.9-.7-.5-1.1C5 14.8 6 13.5 6 10Z" />
      <path d="M10 19.5a2.2 2.2 0 0 0 4 0" />
    </>
  ),
  'chevron-down': <path d="m6.5 9.5 5.5 5.5 5.5-5.5" />,
  'chevron-right': <path d="m9.5 6.5 5.5 5.5-5.5 5.5" />,
  'chevron-left': <path d="m14.5 6.5-5.5 5.5 5.5 5.5" />,
  folder: <path d="M3.5 7.2c0-1.1.9-2 2-2h3.6c.5 0 1 .2 1.4.6l1.2 1.2h6.8c1.1 0 2 .9 2 2v7.8c0 1.1-.9 2-2 2h-13c-1.1 0-2-.9-2-2V7.2Z" />,
  chat: (
    <>
      <rect x="4" y="5" width="16" height="12.5" rx="3" />
      <path d="M8.5 20.5 12 17.5" />
    </>
  ),
  send: <path d="M12 18V6.5M6.5 11.5 12 6l5.5 5.5" />,
  stop: <rect x="7" y="7" width="10" height="10" rx="2.5" fill="currentColor" stroke="none" />,
  shield: <path d="M12 3.5 5.5 6v5.2c0 4.2 2.8 7 6.5 8.8 3.7-1.8 6.5-4.6 6.5-8.8V6L12 3.5Z" />,
  'shield-alert': <><path d="M12 3.5 5.5 6v5.2c0 4.2 2.8 7 6.5 8.8 3.7-1.8 6.5-4.6 6.5-8.8V6L12 3.5Z" /><path d="M12 8v4" /><circle cx="12" cy="15.5" r="0.9" fill="currentColor" stroke="none" /></>,
  attach: (
    <>
      <path d="M12 5v14" />
      <path d="M8.5 8.5V16a3.5 3.5 0 0 0 7 0V7.5a2 2 0 0 0-4 0V16" />
    </>
  ),
  bot: (
    <>
      <rect x="5" y="8" width="14" height="10.5" rx="3" />
      <path d="M12 8V4.5M9.5 4.5h5" />
      <path d="M9.5 12.8v1.4M14.5 12.8v1.4" />
    </>
  ),
  sparkle: (
    <>
      <path d="M12 4.5 13.6 9l4.4 1.6-4.4 1.6L12 16.6l-1.6-4.4L6 10.6 10.4 9 12 4.5Z" />
      <path d="M18.5 15.5l.7 1.9 1.8.7-1.8.7-.7 1.9-.7-1.9-1.8-.7 1.8-.7.7-1.9Z" />
    </>
  ),
  brain: (
    <>
      <path d="M12 5a3 3 0 0 0-5.9-.7A4 4 0 0 0 3.4 10a4 4 0 0 0-.4 7 4 4 0 0 0 4 4 3 3 0 0 0 5-2.2V5Z" />
      <path d="M12 5a3 3 0 0 1 5.9-.7 4 4 0 0 1 2.7 5.7 4 4 0 0 1 .4 7 4 4 0 0 1-4 4 3 3 0 0 1-5-2.2" />
      <path d="M6.1 4.3A3 3 0 0 0 7 7M17.9 4.3A3 3 0 0 1 17 7M8 12a4 4 0 0 0 4-4 4 4 0 0 0 4 4M3 17a4 4 0 0 1 2-1M21 17a4 4 0 0 0-2-1M7 21a4 4 0 0 0 1-3M17 21a4 4 0 0 1-1-3" />
    </>
  ),
  sliders: (
    <>
      <path d="M5 8h8M17 8h2M5 16h2M11 16h8" />
      <circle cx="15" cy="8" r="2" />
      <circle cx="9" cy="16" r="2" />
    </>
  ),
  keyboard: (
    <>
      <rect x="3" y="6.5" width="18" height="11" rx="2.5" />
      <path d="M7 10h.01M11 10h.01M15 10h.01M17 10h.01M7 13.5h.01M17 13.5h.01M10 13.5h4" />
    </>
  ),
  book: (
    <>
      <path d="M12 6.5C10.5 5 8.5 4.5 5.5 4.5c-.6 0-1 .4-1 1v11c0 .6.4 1 1 1 3 0 5 .5 6.5 2 1.5-1.5 3.5-2 6.5-2 .6 0 1-.4 1-1v-11c0-.6-.4-1-1-1-3 0-5 .5-6.5 2Z" />
      <path d="M12 6.5v13" />
    </>
  ),
  stack: (
    <>
      <rect x="4" y="5" width="16" height="5.5" rx="1.8" />
      <rect x="4" y="13.5" width="16" height="5.5" rx="1.8" />
      <path d="M7 7.8h.01M7 16.2h.01" />
    </>
  ),
  box: (
    <>
      <path d="m12 3.5 7.5 4.3v8.4L12 20.5l-7.5-4.3V7.8L12 3.5Z" />
      <path d="M12 12 4.8 7.9M12 12l7.2-4.1M12 12v8.3" />
    </>
  ),
  download: (
    <>
      <path d="M12 4v10M8 10.5l4 4 4-4" />
      <path d="M5 19.5h14" />
    </>
  ),
  archive: (
    <>
      <rect x="4" y="4.5" width="16" height="4.5" rx="1.5" />
      <path d="M5.5 9v8c0 1.1.9 2 2 2h9c1.1 0 2-.9 2-2V9" />
      <path d="M10 13h4" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
  instructions: (
    <>
      <rect x="5" y="4" width="14" height="16" rx="2.5" />
      <path d="M9 9h6M9 12.5h6M9 16h3.5" />
    </>
  ),
  file: (
    <>
      <path d="M7 3.5h6.5L18 8v11a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 19V5a1.5 1.5 0 0 1 1-1.5Z" />
      <path d="M13.5 3.5V8H18" />
    </>
  ),
  code: <path d="m9 8.5-4 3.5 4 3.5M15 8.5l4 3.5-4 3.5" />,
  globe: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.3 2.3 3.4 5.2 3.4 8.5s-1.1 6.2-3.4 8.5c-2.3-2.3-3.4-5.2-3.4-8.5S9.7 5.8 12 3.5Z" />
    </>
  ),
  diff: (
    <>
      <path d="M9 5.5h10M14 3v5" />
      <path d="M5 18.5h10" />
      <path d="M5 5.5h2M17 18.5h2" opacity="0.45" />
    </>
  ),
  check: <path d="m5.5 12.5 4.2 4.2L18.5 8" />,
  'check-circle': (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m8.5 12.3 2.4 2.4 4.6-4.9" />
    </>
  ),
  x: <path d="m6.5 6.5 11 11M17.5 6.5l-11 11" />,
  warning: (
    <>
      <path d="M12 4.2 21 19.5H3L12 4.2Z" />
      <path d="M12 10v4M12 16.8h.01" />
    </>
  ),
  refresh: (
    <>
      <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3L19.5 9" />
      <path d="M19.5 4.5V9H15" />
    </>
  ),
  'download-cloud': (
    <>
      <path d="M7 18.5a4.5 4.5 0 0 1-.4-9A5.5 5.5 0 0 1 17.3 8a4 4 0 0 1-.3 8H7Z" transform="translate(0 -1.5) scale(0.98)" />
      <path d="M12 11.5V20M9 17.2l3 3 3-3" />
    </>
  ),
  link: (
    <>
      <path d="M10 14.5 14.5 10" />
      <path d="M8 12 5.8 14.2a3.6 3.6 0 0 0 5.1 5.1L13 17.2M16 12l2.2-2.2a3.6 3.6 0 0 0-5.1-5.1L11 6.8" />
    </>
  ),
  trash: (
    <>
      <path d="M5 6.5h14M9.5 6.5V5c0-.8.7-1.5 1.5-1.5h2c.8 0 1.5.7 1.5 1.5v1.5" />
      <path d="M6.5 6.5 7.4 19a1.6 1.6 0 0 0 1.6 1.5h6a1.6 1.6 0 0 0 1.6-1.5l.9-12.5" />
      <path d="M9.5 10.5v6M14.5 10.5v6" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V6a2 2 0 0 1 2-2h9" />
    </>
  ),
  pencil: (
    <>
      <path d="M14.5 5.5 18 9 8.5 18.5 4.5 19.5l1-4L14.5 5.5Z" />
      <path d="m12.5 7.5 3.5 3.5" />
    </>
  ),
  circle: <circle cx="12" cy="12" r="4.5" />,
  more: (
    <>
      <circle cx="6" cy="12" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="18" cy="12" r="1.1" fill="currentColor" stroke="none" />
    </>
  ),
  'globe-scope': (
    <>
      <circle cx="12" cy="12" r="7.5" />
      <path d="M4.5 12h15M12 4.5c1.9 2 2.9 4.6 2.9 7.5s-1 5.5-2.9 7.5c-1.9-2-2.9-4.6-2.9-7.5s1-5.5 2.9-7.5Z" />
    </>
  ),
  'edit-files': (
    <>
      <rect x="4" y="5" width="12" height="14" rx="2" />
      <path d="M17.5 3.5 21 7l-5.5 5.5-3 .8.8-3 4.2-4.3Z" />
    </>
  ),
  'read-files': (
    <>
      <path d="M7 3.5h6.5L18 8v11a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 19V5a1.5 1.5 0 0 1 1-1.5Z" />
      <path d="M9.5 12.5h5M9.5 16h3" />
    </>
  ),
  network: (
    <>
      <circle cx="12" cy="12" r="2.2" />
      <path d="M12 3.5v4M12 16.5v4M3.5 12h4M16.5 12h4" />
      <circle cx="12" cy="4.8" r="1.4" />
      <circle cx="12" cy="19.2" r="1.4" />
      <circle cx="4.8" cy="12" r="1.4" />
      <circle cx="19.2" cy="12" r="1.4" />
    </>
  ),
  terminal: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <path d="m7 9.5 3 2.5-3 2.5M12.5 15H17" />
    </>
  ),
  switch: (
    <>
      <rect x="3" y="7.5" width="18" height="9" rx="4.5" />
      <circle cx="16.5" cy="12" r="3" fill="currentColor" stroke="none" />
    </>
  ),
  notepad: (
    <>
      <path d="M8 2v4M12 2v4M16 2v4" />
      <rect width="16" height="18" x="4" y="4" rx="2" />
      <path d="M8 10h6M8 14h8M8 18h5" />
    </>
  ),
  'arrow-right': <><path d="M5 12h14" /><path d="m12 5 7 7-7 7" /></>,
  'arrow-left': <><path d="M19 12H5" /><path d="m12 19-7-7 7-7" /></>,
};

export interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
  style?: CSSProperties;
}

export function Icon({ name, size = 17, className, style }: IconProps) {
  return (
    <svg
      className={className}
      style={style}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

/**
 * Pi brand mark: coral top bar with a blue left leg and yellow right leg,
 * each a straight stem flaring into an outward-curving foot. Colors and
 * geometry were sampled/traced from the reference icon
 * (bar #fd7359, legs #45a6d8 / #ffc83e). Independent redraw, not the
 * upstream image asset.
 */
export function PiBrandMark({ size = 92, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      {/* top bar */}
      <rect x="2.4" y="2.4" width="19.2" height="3.3" rx="0.3" fill="#fd7359" />
      {/* left leg (blue): straight stem, then a symmetric outward-curving foot */}
      <path
        d="M7.8 5.7 V18.2 C7.3 20.1 5.9 20.9 4.1 20.95"
        stroke="#45a6d8"
        strokeWidth="3.8"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* right leg (yellow), mirrored */}
      <path
        d="M16.2 5.7 V18.2 C16.7 20.1 18.1 20.9 19.9 20.95"
        stroke="#ffc83e"
        strokeWidth="3.8"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
