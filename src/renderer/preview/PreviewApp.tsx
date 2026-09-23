/**
 * PreviewApp (U01 skeleton, U07 integration): the explicit UI-preview entry.
 *
 * Rendered only when the URL carries ?preview=1 (see src/renderer/main.tsx).
 * It never touches window.pi / the main process — all data is demo data from
 * fixtures.ts through the adapter store, and a fixed badge marks the UI as a
 * preview. The normal app entry is untouched.
 */

import { useEffect } from 'react';
import { Icon } from '../replica/Icons';
import { replicaLabels } from '../replica/i18n';
import { Sidebar } from '../replica/shell/Sidebar';
import { TopBar } from '../replica/shell/TopBar';
import { ChatView, Composer, HomeView } from '../replica/chat/ChatView';
import { PluginsPage } from '../replica/plugins/PluginsPage';
import { SettingsPage } from '../replica/settings/SettingsPage';
import type { SearchItem, SettingsSectionData } from '../replica/contracts';
import { WorkbenchPanel } from '../replica/workbench/WorkbenchPanel';
import { GlobalSearch, Notifications } from '../replica/overlays/Overlays';
import {
  activeSessionMeta,
  buildSidebarModel,
  sessionTitle,
  useDemoStore,
} from './adapter';
import {
  demoFiles,
  demoModelGroups,
  demoSearchItems,
  demoSlashCommands,
  demoWorkbenchDiffs,
  demoWorkbenchFiles,
} from './fixtures';
import '../replica/tokens.css';
import './preview.css';

export function PreviewApp() {
  const s = useDemoStore();
  const t = replicaLabels(s.lang);
  const isDark = s.theme === 'dark';
  const rootClass = `pireplica ${isDark ? 'pireplica--dark' : ''}`;
  const meta = activeSessionMeta(s);
  const title = sessionTitle(s, s.activeSessionId);
  const demoLabel = t.composer.demoBadge;

  // Cmd/Ctrl+K opens the global search overlay.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        s.setSearchOpen(!s.searchOpen);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [s]);

  const composer = (
    <Composer
      sessionActive={Boolean(s.activeSessionId) && s.view === 'chat'}
      modelId={s.modelId}
      modelGroups={demoModelGroups}
      reasoning={s.reasoning}
      agentMode={s.agentMode}
      permissionMode={s.permissionMode}
      slashCommands={demoSlashCommands(s.lang)}
      files={demoFiles(s.lang)}
      running={s.running}
      queued={s.queued}
      demo
      labels={t.composer}
      onSend={s.send}
      onStop={s.stop}
      onPickModel={(id) => s.setComposer({ modelId: id })}
      onPickReasoning={(level) => s.setComposer({ reasoning: level })}
      onPickAgentMode={(mode) => s.setComposer({ agentMode: mode })}
      onPickPermission={(mode) => s.setComposer({ permissionMode: mode })}
    />
  );

  const generalSections: SettingsSectionData[] = [
    {
      title: t.settings.appearance,
      rows: [
        {
          id: 'theme',
          title: t.settings.theme,
          description: t.settings.themeDesc,
          control: { kind: 'select', value: s.theme === 'dark' ? 'Dark' : 'Light', options: ['Light', 'Dark'] },
        },
        {
          id: 'language',
          title: t.settings.language,
          description: t.settings.languageDesc,
          control: { kind: 'select', value: s.lang === 'zh' ? '中文' : 'English', options: ['English', '中文'] },
        },
        {
          id: 'font',
          title: t.settings.font,
          description: t.settings.fontDesc,
          control: { kind: 'select', value: s.font, options: ['System default', 'Serif', 'Mono'] },
        },
        {
          id: 'fontsize',
          title: t.settings.fontSize,
          description: t.settings.fontSizeDesc,
          control: { kind: 'slider', value: s.fontScale, min: 85, max: 125, suffix: '%', options: ['Tall', 'Grande', 'Venti', 'Trenta'] },
        },
      ],
    },
    {
      title: t.settings.network,
      rows: [
        {
          id: 'proxy',
          title: t.settings.proxy,
          description: t.settings.proxyDesc,
          control: { kind: 'segmented', value: s.proxy, options: ['System', 'Direct', 'Custom'] },
        },
      ],
    },
  ];

  const fontFamily =
    s.font === 'Serif' ? 'Georgia, "Songti SC", serif' : s.font === 'Mono' ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : undefined;

  const showTopBar = s.view === 'home' || s.view === 'chat';

  const searchSelect = (item: SearchItem) => {
    if (item.kind === 'page') {
      s.navigate('plugins');
    } else if (item.kind === 'setting') {
      s.openSettings('general');
    } else {
      s.selectSession('sess-plugin-ui');
    }
    s.setSearchOpen(false);
  };

  const sidebar = (
    <Sidebar
      projects={buildSidebarModel(s).projects}
      temporarySessions={buildSidebarModel(s).temporary}
      activeSessionId={s.view === 'chat' || s.view === 'home' ? s.activeSessionId : null}
      collapsed={s.sidebarCollapsed}
      version="v0.1.0-demo"
      labels={t.sidebar}
      onSelectSession={s.selectSession}
      onNewSession={s.newSession}
      onOpenSearch={() => s.setSearchOpen(true)}
      searchOpen={s.searchOpen}
      onToggleProject={s.toggleProject}
      onToggleCollapse={s.toggleSidebar}
      onOpenSettings={() => s.openSettings()}
      onOpenPlugins={() => s.navigate('plugins')}
      onToggleNotifications={s.toggleNotifications}
      onRenameSession={s.renameSession}
      notificationsCount={s.notifications.filter((n) => !n.read).length}
      activeOverlay={s.view === 'plugins' ? 'plugins' : s.view === 'settings' ? 'settings' : s.notificationsOpen ? 'notifications' : null}
    />
  );

  return (
    <div
      className={rootClass}
      style={{ height: '100vh', fontSize: `${s.fontScale}%`, ...(fontFamily ? { fontFamily } : {}) }}
      data-preview="1"
    >
      {s.view === 'settings' ? (
        <SettingsPage
          page={s.settingsPage}
          query={s.searchQuery}
          theme={s.theme}
          sections={generalSections}
          providers={s.providers}
          providerForm={s.providerForm}
          defaultModelLabel={s.defaultModelLabel}
          vendorEmpty={t.settings.noVendor}
          catalogInfo="Catalog: bundled snapshot · 7617 models · updated never"
          demo
          labels={t.settings}
          onBack={s.backToApp}
          onSearch={s.setSettingsQuery}
          onSelectPage={s.selectSettingsPage}
          onRowControl={s.rowControl}
          onSetProviderForm={s.setProviderForm}
          onSaveProvider={s.addProvider}
          onSaveProviderModel={async (providerId,model,originalId)=>{
            useDemoStore.setState(state=>({providers:state.providers.map(p=>{
              if(p.id!==providerId)return p;
              const models=originalId?p.models.map(m=>m.id===originalId?model:m):[...p.models,model];
              return {...p,models,modelCount:models.length};
            })}));
          }}
          onEditProvider={s.editProvider}
          onDeleteProvider={s.deleteProvider}
          onToggleProvider={s.toggleProvider}
          onMakeDefault={s.makeDefault}
          onRefreshCatalog={s.refreshCatalog}
        />
      ) : (
        <>
          {sidebar}
          <div className="pireplica__main" style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
            {showTopBar && (
              <TopBar
                title={title || demoLabel}
                labels={t.topbar}
                onNewSession={s.newSession}
                onOpenSearch={() => s.setSearchOpen(true)}
                onToggleWorkbench={s.toggleWorkbench}
                workbenchOpen={s.workbenchOpen}
              />
            )}
            <div style={{ flex: 1, minHeight: 0, display: 'flex', position: 'relative' }}>
              {s.view === 'home' && (
                <HomeView greeting={s.lang === 'zh' ? '想从哪里开始探索？' : 'What would you like to explore?'} composer={composer} />
              )}
              {s.view === 'chat' && (
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                  {meta.source === 'pi-cli' && (
                    <div className="pi-clibanner">
                      <span>
                        {t.sidebar.readOnlyBadge}
                        {meta.syncedAt ? ` · ${s.lang === 'zh' ? '同步于' : 'synced'} ${meta.syncedAt}` : ''}
                      </span>
                      {meta.canContinue && (
                        <button
                          className="pi-btn pi-btn--outline"
                          onClick={() =>
                            useDemoStore.setState({
                              notifications: [
                                {
                                  id: `nt-handoff-${Date.now()}`,
                                  kind: 'info',
                                  title: s.lang === 'zh' ? '“在 Desktop 继续”是演示动作' : '“Continue in Desktop” is a demo action',
                                  body: s.lang === 'zh' ? '接续流程将在 pi 接入阶段实现。' : 'Hand-off lands with the pi integration phase.',
                                  time: s.lang === 'zh' ? '刚刚' : 'just now',
                                  read: false,
                                },
                                ...s.notifications,
                              ],
                              notificationsOpen: true,
                            })
                          }
                        >
                          {t.sidebar.continueHere}
                        </button>
                      )}
                    </div>
                  )}
                  <ChatView messages={s.messages[s.activeSessionId ?? ''] ?? []} running={s.running} queued={s.queued} demo labels={t.chat} onJumpToMessage={() => {}} />
                  <div style={{ padding: '0 24px 20px' }}>{composer}</div>
                </div>
              )}
              {s.view === 'plugins' && (
                <PluginsPage
                  tab={s.pluginTab}
                  installed={s.plugins}
                  marketplace={s.marketplace}
                  search={s.pluginSearch}
                  marketplaceSource={s.marketplaceSource}
                  marketplaceSources={['GitHub (official)', 'Example mirror (demo)']}
                  tag={s.pluginTag}
                  tags={['editing', 'productivity', 'data']}
                  updatesReady={s.pluginUpdatesReady}
                  demo
                  labels={t.plugins}
                  onSelectTab={s.setPluginTab}
                  onSearch={s.setPluginSearch}
                  onSelectTag={s.setPluginTag}
                  onSelectSource={s.setMarketplaceSource}
                  onTogglePlugin={s.togglePlugin}
                  onUpdatePlugin={s.updatePlugin}
                  onInstallPlugin={s.installPlugin}
                  onOpenMarketplace={() => s.setPluginTab('marketplace')}
                  onRefreshMarketplace={s.refreshMarketplace}
                  onApplyUpdates={s.applyUpdates}
                />
              )}
              <WorkbenchPanel
                open={s.workbenchOpen && (s.view === 'chat' || s.view === 'home')}
                tab={s.workbenchTab}
                diffs={demoWorkbenchDiffs}
                files={demoWorkbenchFiles()}
                selectedFile={s.selectedFile}
                demo
                labels={t.workbench}
                onToggle={s.toggleWorkbench}
                onSelectTab={s.selectWorkbenchTab}
                onSelectFile={s.selectFile}
              />
            </div>
          </div>
        </>
      )}

      {/* fixed preview badge + reset */}
      <div className="pi-previewbadge">
        <Icon name="sparkle" size={12} />
        <span>{demoLabel}</span>
        <button
          className="pi-previewbadge__reset"
          onClick={() => {
            if (window.confirm(s.lang === 'zh' ? '重置演示数据？' : 'Reset demo data?')) s.reset();
          }}
          aria-label={s.lang === 'zh' ? '重置演示数据' : 'Reset demo data'}
          title={s.lang === 'zh' ? '重置演示数据' : 'Reset demo data'}
        >
          <Icon name="refresh" size={12} />
        </button>
      </div>

      <GlobalSearch
        open={s.searchOpen}
        query={s.searchQuery}
        items={demoSearchItems(s.lang)}
        demo
        labels={t.search}
        onQuery={s.setSearchQuery}
        onClose={() => s.setSearchOpen(false)}
        onSelect={searchSelect}
      />
      <Notifications
        open={s.notificationsOpen}
        items={s.notifications}
        demo
        labels={t.notifications}
        onClose={s.toggleNotifications}
        onMarkAllRead={s.markAllRead}
        onSelect={() => s.toggleNotifications()}
      />
    </div>
  );
}
