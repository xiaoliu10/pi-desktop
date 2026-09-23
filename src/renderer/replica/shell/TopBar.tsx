/**
 * Top bar replica (U02): session title on the left; new-session, search and
 * work-panel icon buttons on the right. Props-driven per contracts.ts.
 */

import type { TopBarProps } from '../contracts';
import { Icon } from '../Icons';
import './topbar.css';

export function TopBar(props: TopBarProps) {
  return (
    <header className="pi-topbar">
      <h1 className="pi-topbar__title" title={props.title}>
        {props.title}
      </h1>
      <div className="pi-topbar__actions">
        <button className="pi-iconbtn" onClick={props.onNewSession} aria-label={props.labels.newSession} title={props.labels.newSession}>
          <Icon name="plus-square" />
        </button>
        <button className="pi-iconbtn" onClick={props.onOpenSearch} aria-label={props.labels.search} title={props.labels.search}>
          <Icon name="search" />
        </button>
        {props.onToggleTerminal && (
          <button
            className="pi-iconbtn"
            onClick={props.onToggleTerminal}
            aria-label={props.labels.terminal ?? 'Terminal'}
            aria-pressed={props.terminalOpen}
            title={props.labels.terminal ?? 'Terminal'}
          >
            <Icon name="terminal" />
          </button>
        )}
        <button
          className="pi-iconbtn"
          onClick={props.onToggleWorkbench}
          aria-label={props.labels.workbench}
          aria-pressed={props.workbenchOpen}
          title={props.labels.workbench}
        >
          <Icon name={props.workbenchOpen ? 'panel-right' : 'panel'} />
        </button>
      </div>
    </header>
  );
}
