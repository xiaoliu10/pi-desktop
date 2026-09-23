/**
 * Sidebar replica (U02): collapse button, Sessions/Projects groups, selected
 * session pill, project expansion, bottom settings/extensions/notifications
 * icons and the version label. Fully props-driven per contracts.ts.
 */

import { Fragment, useState, useEffect, useRef } from 'react';
import type { ProjectNavItem, SessionNavItem, SidebarProps } from '../contracts';
import { Icon } from '../Icons';
import { Spinner } from '../chat/ChatView';
import { buildSidebarLists, formatSessionTime, SIDEBAR_SESSION_LIMIT, visibleSessions } from './helpers';
import './sidebar.css';

export function Sidebar(props: SidebarProps) {
  const lists = buildSidebarLists(props.temporarySessions, props.projects, '');

  const zh = props.labels.projects === '项目';
  const actions = <nav className="pi-sidebar__actions" aria-label={zh ? '功能导航' : 'Main navigation'}>
    <button className="pi-sidebar__action" onClick={props.onNewSession} title={zh ? '新建任务' : 'New task'}>
      <Icon name="plus-circle" size={16} /><span>{zh ? '新建任务' : 'New task'}</span><kbd>{props.shortcutHints?.newSession}</kbd>
    </button>
    <button className="pi-sidebar__action" onClick={props.onOpenSearch} disabled={!props.onOpenSearch} aria-expanded={props.searchOpen ?? false} title={props.labels.search}>
      <Icon name="search" size={16} /><span>{props.labels.search}</span><kbd>{props.shortcutHints?.search}</kbd>
    </button>
    <button className={`pi-sidebar__action ${props.activeOverlay === 'automations' ? 'pi-sidebar__action--active' : ''}`} aria-current={props.activeOverlay === 'automations' ? 'page' : undefined} onClick={props.onOpenAutomations} disabled={!props.onOpenAutomations} title={props.onOpenAutomations ? (zh ? '自动化' : 'Automations') : (zh ? '自动化：定时任务功能尚未实现' : 'Automations: scheduling is not implemented yet')}>
      <Icon name="calendar-clock" size={16} /><span>{zh ? '自动化' : 'Automations'}</span>
    </button>
    <button className={`pi-sidebar__action ${props.activeOverlay === 'plugins' ? 'pi-sidebar__action--active' : ''}`} onClick={props.onOpenPlugins} aria-current={props.activeOverlay === 'plugins' ? 'page' : undefined} title={zh ? '查看本地扩展；在线插件市场尚未接入' : 'Browse local extensions; online marketplace is not connected'}>
      <Icon name="grid" size={16} /><span>{zh ? '插件市场' : 'Plugin marketplace'}</span>
    </button>
  </nav>;

  if (props.collapsed) {
    return (
      <aside className="pi-sidebar pi-sidebar--collapsed">
        <button
          className="pi-iconbtn"
          onClick={props.onToggleCollapse}
          aria-label={zh ? '展开侧边栏' : 'Expand sidebar'}
          title={zh ? '展开侧边栏' : 'Expand sidebar'}
          aria-expanded={false}
        >
          <Icon name="sidebar" />
        </button>
      </aside>
    );
  }

  return (
    <aside className="pi-sidebar">
      <div className="pi-sidebar__top">
        <button
          className="pi-iconbtn"
          onClick={props.onToggleCollapse}
          aria-label="Collapse sidebar"
          title="Collapse sidebar"
        >
          <Icon name="sidebar" />
        </button>
        {props.onNavBack && (
          <div className="pi-sidebar__nav">
            <button
              className="pi-iconbtn"
              onClick={props.onNavBack}
              disabled={!props.canNavBack}
              aria-label={props.navLabels?.back ?? 'Back'}
              title={props.navLabels?.back ?? 'Back'}
            >
              <Icon name="arrow-left" size={16} />
            </button>
            <button
              className="pi-iconbtn"
              onClick={props.onNavForward}
              disabled={!props.canNavForward}
              aria-label={props.navLabels?.forward ?? 'Forward'}
              title={props.navLabels?.forward ?? 'Forward'}
            >
              <Icon name="arrow-right" size={16} />
            </button>
          </div>
        )}
      </div>

      {actions}
      <div className="pi-sidebar__scroll">
        {lists.temporary.length > 0 && (
          <>
            <div className="pi-group-label pi-sidebar__grouplabel">{props.labels.sessions}</div>
            <ul className="pi-sidebar__list" role="list">
              {lists.temporary.map((s) => (
                <SessionRow
                  key={s.id}
                  session={s}
                  active={s.id === props.activeSessionId}
                  labels={props.labels}
                  onSelect={() => props.onSelectSession(s.id)}
                  onRename={(name) => props.onRenameSession?.(s.id, name)}
                  onArchive={props.onArchiveSession ? () => props.onArchiveSession!(s.id) : undefined}
                />
              ))}
            </ul>
          </>
        )}

        <div className="pi-group-label pi-sidebar__grouplabel pi-sidebar__projectheading">
          <span>{props.labels.projects}</span>
          {props.onAddProject && <button className="pi-iconbtn" onClick={props.onAddProject} disabled={props.addingProject} aria-label={zh ? '新增项目' : 'Add project'} title={zh ? '新增项目 · 选择本地目录' : 'Add a local project'}><Icon name="plus" size={14} /></button>}
        </div>
        <ul className="pi-sidebar__list" role="list">
          {lists.projects.map((p,index) => (
            <Fragment key={p.id}>
            {(p.pinned || p.section) && (index===0 || (lists.projects[index-1].pinned?'__pinned':lists.projects[index-1].section)!==(p.pinned?'__pinned':p.section)) && <li className="pi-group-label pi-sidebar__sectionlabel">{p.pinned?(zh?'置顶':'Pinned'):p.section}</li>}
            {!p.pinned && !p.section && index>0 && (lists.projects[index-1].pinned||lists.projects[index-1].section) && <li className="pi-group-label pi-sidebar__sectionlabel">{props.labels.projects}</li>}
            <ProjectRow
              key={p.id}
              project={p}
              menu={props.projectMenu?.(p)}
              activeSessionId={props.activeSessionId}
              labels={props.labels}
              onSelectSession={props.onSelectSession}
              onToggle={() => props.onToggleProject(p.id)}
              onRename={props.onRenameSession}
              onArchive={props.onArchiveSession}
            /></Fragment>
          ))}
        </ul>
      </div>

      <div className="pi-sidebar__footer">
        <div className="pi-sidebar__footericons">
          <button
            className={`pi-iconbtn ${props.activeOverlay === 'settings' ? 'pi-iconbtn--on' : ''}`}
            onClick={props.onOpenSettings}
            aria-label={props.labels.settings}
            title={props.labels.settings}
          >
            <Icon name="settings" />
          </button>
          <button
            className={`pi-iconbtn ${props.activeOverlay === 'plugins' ? 'pi-iconbtn--on' : ''}`}
            onClick={props.onOpenPlugins}
            aria-label={props.labels.plugins}
            title={props.labels.plugins}
          >
            <Icon name="plug" />
          </button>
          <button
            className={`pi-iconbtn ${props.notificationsCount ? 'pi-iconbtn--dot' : ''} ${props.activeOverlay === 'notifications' ? 'pi-iconbtn--on' : ''}`}
            onClick={props.onToggleNotifications}
            aria-label={props.labels.notifications}
            title={props.labels.notifications}
          >
            <Icon name="bell" />
          </button>
        </div>
        <span className="pi-sidebar__version">{props.version}</span>
      </div>
    </aside>
  );
}

function SessionRow(props: {
  session: SessionNavItem;
  active: boolean;
  labels: SidebarProps['labels'];
  onSelect: () => void;
  /** Persist a new display name. Electron renderers have no window.prompt. */
  onRename: (name: string) => void;
  onArchive?: () => void;
}) {
  const s = props.session;
  const [menu,setMenu]=useState(false);
  const [menuPosition,setMenuPosition]=useState({left:0,top:0});
  const [editing,setEditing]=useState(false);
  const [draft,setDraft]=useState('');
  const editRef=useRef<HTMLInputElement>(null);
  const root=useRef<HTMLLIElement>(null);
  const more=useRef<HTMLButtonElement>(null);
  const zh=props.labels.projects==='项目';
  useEffect(()=>{if(!menu)return;const close=(e:MouseEvent)=>{if(!root.current?.contains(e.target as Node))setMenu(false);};const key=(e:KeyboardEvent)=>{if(e.key==='Escape'){setMenu(false);more.current?.focus();}};document.addEventListener('mousedown',close);document.addEventListener('keydown',key);return()=>{document.removeEventListener('mousedown',close);document.removeEventListener('keydown',key);};},[menu]);
  const beginEdit=()=>{setDraft(s.title);setEditing(true);setMenu(false);requestAnimationFrame(()=>editRef.current?.select());};
  const commit=()=>{setEditing(false);const name=draft.trim();if(name&&name!==s.title)props.onRename(name);};
  return (
    <li ref={root} className="pi-sidebar__session">
      <div
        role="button"
        tabIndex={0}
        className={`pi-sidebar__row ${props.active ? 'pi-sidebar__row--active' : ''}`}
        onClick={() => { if (!editing) props.onSelect(); }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenuPosition({ left: Math.max(8, Math.min(e.clientX, window.innerWidth - 190)), top: Math.max(8, Math.min(e.clientY, window.innerHeight - 100)) });
          setMenu(true);
        }}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            props.onSelect();
          }
        }}
        aria-current={props.active ? 'true' : undefined}
        title={s.title}
      >
        <span className="pi-sidebar__rowslot">
          {s.busy ? (
            <Spinner label={zh ? '任务运行中' : 'Task running'} />
          ) : s.source === 'pi-cli' ? (
            <Icon name="terminal" size={13} />
          ) : null}
        </span>
        {editing ? (
          <input
            ref={editRef}
            className="pi-sidebar__edit"
            value={draft}
            maxLength={200}
            aria-label={zh ? '会话名称' : 'Session name'}
            onChange={(e) => setDraft(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onBlur={commit}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') { e.preventDefault(); commit(); }
              if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
            }}
          />
        ) : (
          <span className="pi-sidebar__rowtitle">{s.title}</span>
        )}
        <span className="pi-sidebar__rowmeta">
          {s.source === 'pi-cli' && <span className="pi-sidebar__sync" title={props.labels.readOnlyBadge}>π</span>}
          <span className="pi-sidebar__time">{formatSessionTime(s.updatedAt)}</span>
        </span>
        <button
          className="pi-sidebar__more"
          ref={more}
          aria-label={zh ? `会话操作：${s.title}` : `Chat actions: ${s.title}`}
          title={zh ? '会话操作' : 'Chat actions'}
          aria-expanded={menu}
          aria-haspopup="menu"
          onClick={(e) => {
            e.stopPropagation();
            const rect=e.currentTarget.getBoundingClientRect();
            setMenuPosition({left:Math.max(8,rect.right-170),top:Math.min(window.innerHeight-100,rect.bottom+4)});
            setMenu(v=>!v);
          }}
        >
          <Icon name="more" size={14} />
        </button>
      </div>
      {menu && <div className="pi-sidebar__sessionmenu" style={menuPosition} role="menu" aria-label={zh?'会话操作':'Chat actions'}>
        <button role="menuitem" autoFocus onClick={beginEdit}><Icon name="pencil" size={14}/>{zh?'重命名任务':'Rename chat'}</button>
        {props.onArchive && <button role="menuitem" disabled={s.busy} title={s.busy?(zh?'请先停止运行中的任务':'Stop the task first'):undefined} onClick={()=>{setMenu(false);props.onArchive?.();}}><Icon name="archive" size={14}/>{zh?'归档任务':'Archive chat'}</button>}
        {s.path && <button role="menuitem" onClick={()=>{setMenu(false);void window.localPi?.revealPath(s.path!).catch(()=>undefined);}}><Icon name="folder" size={14}/>{zh?'在 Finder 中打开':'Reveal in Finder'}</button>}
        {s.cwd && <button role="menuitem" onClick={()=>{setMenu(false);void navigator.clipboard.writeText(s.cwd!);}}><Icon name="copy" size={14}/>{zh?'复制路径':'Copy path'}</button>}
        {s.path && <button role="menuitem" onClick={()=>{setMenu(false);void navigator.clipboard.writeText(s.path!);}}><Icon name="copy" size={14}/>{zh?'复制日志路径':'Copy log path'}</button>}
        <button role="menuitem" onClick={()=>{setMenu(false);void navigator.clipboard.writeText(s.id);}}><Icon name="copy" size={14}/>{zh?'复制会话 ID':'Copy session ID'}</button>
      </div>}
    </li>
  );
}

function ProjectRow(props: {
  project: ProjectNavItem;
  menu?: import('react').ReactNode;
  activeSessionId: string | null;
  labels: SidebarProps['labels'];
  onSelectSession: (id: string) => void;
  onToggle: () => void;
  onRename?: (id: string, name: string) => void;
  onArchive?: (id: string) => void;
}) {
  const p = props.project;
  // Only the most recent SIDEBAR_SESSION_LIMIT sessions stay visible until
  // the user expands; collapsing the project resets the choice.
  const [showAll, setShowAll] = useState(false);
  const shown = visibleSessions(p.sessions, showAll);
  const expandable = p.sessions.length > SIDEBAR_SESSION_LIMIT;
  const toggle = () => {
    if (p.expanded) setShowAll(false);
    props.onToggle();
  };
  return (
    <li className="pi-sidebar__project">
      <div
        role="button"
        tabIndex={0}
        className="pi-sidebar__projrow"
        // 单击折叠/展开；点行内的菜单等交互控件时不触发
        onClick={(e) => { if ((e.target as HTMLElement).closest('button, a, input, [role="menu"]')) return; toggle(); }}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggle();
          }
        }}
        aria-expanded={p.expanded}
        title={props.labels.collapseSessions ? (p.expanded ? props.labels.collapseSessions : (props.labels.showAllSessions ?? '')) : undefined}
      >
        <Icon name="folder" size={15} />
        <span className="pi-sidebar__rowtitle">{p.name}</span>
        {p.pinned && <Icon name="pin" size={12}/>}
        {props.menu}
      </div>
      {p.expanded && (
        <ul className="pi-sidebar__list pi-sidebar__list--nested" role="list">
          {shown.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              active={s.id === props.activeSessionId}
              labels={props.labels}
              onSelect={() => props.onSelectSession(s.id)}
              onRename={(name) => props.onRename?.(s.id, name)}
              onArchive={props.onArchive ? () => props.onArchive!(s.id) : undefined}
            />
          ))}
          {p.sessions.length === 0 && <li className="pi-sidebar__empty">{props.labels.noChats}</li>}
          {expandable && (
            <li>
              <button
                className="pi-sidebar__showall"
                onClick={() => setShowAll((v) => !v)}
                aria-expanded={showAll}
              >
                {showAll
                  ? (props.labels.collapseSessions ?? '收起')
                  : (props.labels.showAllSessions ?? `显示全部 ${p.sessions.length} 个`)}
              </button>
            </li>
          )}
        </ul>
      )}
    </li>
  );
}
