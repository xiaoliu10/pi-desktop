/**
 * Plugins page replica (U04): header with marketplace entry, update banner,
 * Installed/Marketplace segmented tabs, search, status-grouped rows and the
 * marketplace card grid. All data comes from props (contracts.ts); install /
 * toggle / update only fire demo callbacks.
 */

import { useEffect, useState } from 'react';
import type { MarketplaceCardData, PluginRowData, PluginsPageProps, PluginStatus } from '../contracts';
import { Icon, type IconName } from '../Icons';
import { filterInstalled, filterMarketplace, groupByStatus, uniqueTags } from './helpers';
import './plugins.css';

const STATUS_LABEL_KEY: Record<PluginStatus, keyof PluginsPageProps['labels']> = {
  attention: 'needsAttention',
  updatable: 'updatesAvailable',
  active: 'active',
  off: 'turnedOff',
};

const PERMISSION_LABEL_KEY: Record<string, keyof PluginsPageProps['labels']> = {
  edit: 'permissionEdit',
  read: 'permissionRead',
  network: 'permissionNetwork',
  spawn: 'permissionSpawn',
  panel: 'permissionPanel',
  clipboard: 'permissionClipboard',
};

const PERMISSION_ICON: Record<string, IconName> = {
  edit: 'edit-files',
  read: 'read-files',
  network: 'network',
  spawn: 'terminal',
  panel: 'panel',
  clipboard: 'file',
};

export function PluginsPage(props: PluginsPageProps) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const filteredInstalled = filterInstalled(props.installed, props.search);
  const groups = groupByStatus(filteredInstalled);
  const marketplaceCards = filterMarketplace(props.marketplace, props.search, props.tag);
  const tagList = uniqueTags(props.marketplace);

  return (
    <div className="pi-plugins">
      <header className="pi-plugins__header">
        <div className="pi-plugins__title">
          <Icon name="plug" size={19} />
          <h1>{props.labels.title}</h1>
        </div>
        <div className="pi-plugins__headactions">
          {props.tab === 'installed' ? (
            props.hideMarketplace ? (
              <button className="pi-btn pi-btn--primary" onClick={props.onRefreshMarketplace}>
                <Icon name="refresh" size={15} />
                {props.labels.refreshMarketplace}
              </button>
            ) : (
              <button className="pi-btn pi-btn--primary" onClick={props.onOpenMarketplace}>
                <Icon name="download-cloud" size={15} />
                {props.labels.browseMarketplace}
              </button>
            )
          ) : (
            <button className="pi-btn pi-btn--primary" onClick={props.onRefreshMarketplace}>
              <Icon name="refresh" size={15} />
              {props.labels.refreshMarketplace}
            </button>
          )}
          <button className="pi-iconbtn" aria-label="More" title="More">
            <Icon name="more" />
          </button>
        </div>
      </header>

      {props.updatesReady > 0 && (
        <div className="pi-plugins__banner">
          <span className="pi-plugins__bannericon">
            <Icon name="download-cloud" size={15} />
          </span>
          <span className="pi-plugins__bannertext">
            {props.updatesReady} {props.labels.updatesReady}
          </span>
          <button className="pi-btn pi-btn--outline" onClick={props.onApplyUpdates}>
            {props.labels.applyUpdates}
          </button>
        </div>
      )}

      <div className="pi-plugins__filterrow">
        <div className="pi-plugins__tabs" role="tablist">
          <button
            role="tab"
            aria-selected={props.tab === 'installed'}
            className={`pi-plugins__tab ${props.tab === 'installed' ? 'pi-plugins__tab--on' : ''}`}
            onClick={() => props.onSelectTab('installed')}
          >
            {props.labels.installed} <span className="pi-plugins__tabcount">{props.installed.length}</span>
          </button>
          {!props.hideMarketplace && (
            <button
              role="tab"
              aria-selected={props.tab === 'marketplace'}
              className={`pi-plugins__tab ${props.tab === 'marketplace' ? 'pi-plugins__tab--on' : ''}`}
              onClick={() => props.onSelectTab('marketplace')}
            >
              {props.labels.marketplace} <span className="pi-plugins__tabcount">{props.marketplace.length}</span>
            </button>
          )}
        </div>
        <input
          className="pi-plugins__search"
          placeholder={props.tab === 'installed' ? props.labels.searchInstalled : props.labels.searchMarketplace}
          value={props.search}
          onChange={(e) => props.onSearch(e.target.value)}
          aria-label={props.tab === 'installed' ? props.labels.searchInstalled : props.labels.searchMarketplace}
        />
      </div>

      {props.demo && <div className="pi-plugins__note">{props.labels.demoNote}</div>}

      {props.tab === 'installed' ? (
        <div className="pi-plugins__list">
          {groups.length === 0 && (
            <div className="pi-plugins__empty">
              {props.search ? props.labels.noResults : (
                <>
                  <div className="pi-plugins__emptytitle">{props.labels.emptyInstalled}</div>
                  <div className="pi-plugins__emptyhint">{props.labels.emptyInstalledHint}</div>
                </>
              )}
            </div>
          )}
          {groups.map((g) => (
            <section key={g.status} className="pi-plugins__group">
              <div className="pi-group-label pi-plugins__grouplabel">
                {props.labels[STATUS_LABEL_KEY[g.status]]}
                <span className="pi-count-badge">{g.items.length}</span>
              </div>
              {g.items.map((p) => (
                <PluginRowItem
                  key={p.id}
                  plugin={p}
                  labels={props.labels}
                  expanded={expanded === p.id}
                  onToggleExpand={() => setExpanded(expanded === p.id ? null : p.id)}
                  onToggle={() => props.onTogglePlugin(p.id)}
                  onUpdate={() => props.onUpdatePlugin(p.id)}
                />
              ))}
            </section>
          ))}
        </div>
      ) : (
        <div className="pi-plugins__market">
          <div className="pi-plugins__source">
            <span className="pi-plugins__sourcetitle">{props.labels.extensionMarketplace}</span>
            <select
              className="pi-plugins__sourceselect"
              value={props.marketplaceSource}
              onChange={(e) => props.onSelectSource(e.target.value)}
              aria-label={props.labels.extensionMarketplace}
            >
              {props.marketplaceSources.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </div>
          <div className="pi-plugins__tags" role="tablist" aria-label="Tags">
            {['all', ...tagList].map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={props.tag === t}
                className={`pi-plugins__tag ${props.tag === t ? 'pi-plugins__tag--on' : ''}`}
                onClick={() => props.onSelectTag(t)}
              >
                {t === 'all' ? props.labels.allTag : t}
              </button>
            ))}
          </div>
          {marketplaceCards.length === 0 && <div className="pi-plugins__empty">{props.labels.noResults}</div>}
          <div className="pi-plugins__grid">
            {marketplaceCards.map((c) => (
              <MarketCard key={c.id} card={c} labels={props.labels} onInstall={() => props.onInstallPlugin(c.id)} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function PluginRowItem(props: {
  plugin: PluginRowData;
  labels: PluginsPageProps['labels'];
  expanded: boolean;
  onToggleExpand: () => void;
  onToggle: () => void;
  onUpdate: () => void;
}) {
  const p = props.plugin;
  const attention = p.status === 'attention';
  return (
    <article className="pi-pluginrow">
      <span className={`pi-pluginrow__icon ${attention ? 'pi-pluginrow__icon--bad' : ''}`}>
        <Icon name={attention ? 'warning' : 'plug'} size={15} />
      </span>
      <div className="pi-pluginrow__body">
        <div className="pi-pluginrow__name">
          {p.name}
          {p.badge && <span className="pi-pluginrow__badge">{p.badge}</span>}
        </div>
        <div className="pi-pluginrow__pkg">
          {p.packageId}
          {p.version ? ` · v${p.version}` : ''}
        </div>
        {p.error && <div className="pi-pluginrow__error">{p.error}</div>}
        <button className="pi-pluginrow__details" aria-expanded={props.expanded} onClick={props.onToggleExpand}>
          <Icon name="chevron-down" size={12} style={{ transform: props.expanded ? 'none' : 'rotate(-90deg)' }} />
          {props.labels.details}
        </button>
        {props.expanded && (
          <div className="pi-pluginrow__detailbody">
            {p.details.map((d, i) => (
              <p key={i}>{d}</p>
            ))}
          </div>
        )}
      </div>
      <div className="pi-pluginrow__actions">
        {p.status === 'updatable' && (
          <button className="pi-btn pi-btn--outline" onClick={props.onUpdate}>
            {props.labels.update}
          </button>
        )}
        {p.primaryAction ? (
          <button className="pi-btn pi-btn--outline" onClick={props.onToggle}>{p.primaryAction}</button>
        ) : p.status === 'off' ? (
          <button className="pi-btn pi-btn--outline" onClick={props.onToggle} aria-label={props.labels.off}>
            <Icon name="switch" size={14} />
            {props.labels.off}
            <Icon name="chevron-down" size={12} />
          </button>
        ) : (
          <button className="pi-btn pi-btn--outline pi-pluginrow__scope" aria-label={props.labels.everywhere}>
            <Icon name="globe-scope" size={14} />
            {p.scope === 'everywhere' ? props.labels.everywhere : props.labels.project}
            <Icon name="chevron-down" size={12} />
          </button>
        )}
        <button className="pi-iconbtn" aria-label="More" title="More">
          <Icon name="more" />
        </button>
      </div>
    </article>
  );
}

/** 封面缩略图：候选 URL 按序降级（jsdelivr → unpkg → raw → gh-proxy），全部失败回退首字母。 */
function CoverImage({ card }: { card: MarketplaceCardData }) {
  const covers = card.covers ?? [];
  const [idx, setIdx] = useState(0);
  useEffect(() => setIdx(0), [card.id, covers.length]);
  const url = idx < covers.length ? covers[idx] : undefined;
  return (
    <span className={`pi-marketcard__avatar ${url ? 'pi-marketcard__avatar--cover' : ''}`}>
      {url ? <img src={url} alt="" loading="lazy" onError={() => setIdx((i) => i + 1)} /> : card.name[0]}
    </span>
  );
}

function MarketCard(props: { card: MarketplaceCardData; labels: PluginsPageProps['labels']; onInstall: () => void }) {
  const c = props.card;
  return (
    <article className="pi-marketcard">
      <div className="pi-marketcard__head">
        <CoverImage card={c} />
        <div className="pi-marketcard__names">
          <div className="pi-marketcard__name">
            {c.name}
            {c.verified && (
              <span className="pi-marketcard__verified" title="Verified">
                <Icon name="check-circle" size={13} />
              </span>
            )}
          </div>
          <div className="pi-marketcard__meta">
            {c.publisher} · v{c.version} · {c.installs.toLocaleString()} installs
          </div>
        </div>
      </div>
      <p className="pi-marketcard__desc">{c.description}</p>
      <div className="pi-marketcard__perms">
        {c.permissions.map((perm) => (
          <span
            key={perm}
            className={`pi-marketcard__perm ${perm === 'read' || perm === 'panel' || perm === 'clipboard' ? '' : 'pi-marketcard__perm--risky'}`}
          >
            <Icon name={PERMISSION_ICON[perm]} size={11} />
            {props.labels[PERMISSION_LABEL_KEY[perm]]}
          </span>
        ))}
      </div>
      <div className="pi-marketcard__foot">
        <span className="pi-marketcard__installstate">
          {c.installedVersion
            ? c.updateAvailable
              ? `Installed v${c.installedVersion}`
              : `Installed v${c.installedVersion}`
            : `Updated ${c.version}`}
        </span>
        {!c.published ? (
          <button className="pi-btn pi-btn--outline" disabled title={props.labels.notPublished}>
            {props.labels.notPublished}
          </button>
        ) : c.updateAvailable ? (
          <button className="pi-btn pi-btn--primary" onClick={props.onInstall}>
            {props.labels.update}
          </button>
        ) : c.installedVersion ? (
          <span className="pi-marketcard__installed">
            <Icon name="check" size={13} /> {props.labels.installedCheck}
          </span>
        ) : (
          <button className="pi-btn pi-btn--primary" onClick={props.onInstall}>
            {props.labels.install}
          </button>
        )}
      </div>
    </article>
  );
}
