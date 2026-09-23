/**
 * Usage statistics pane: aggregates tokens / cost / model calls from the
 * local pi session files (same source of truth as the CLI). Numbers only —
 * nothing is sent anywhere.
 */

import { useEffect, useState } from 'react';
import type { PiUsageStats } from '../../shared/pi';
import { usePiStore } from './adapter';

const api = () => window.localPi;

function fmtTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtCost(n: number): string {
  if (n <= 0) return '$0.00';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function UsagePane() {
  const s = usePiStore();
  const zh = s.lang === 'zh';
  const [stats, setStats] = useState<PiUsageStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = (force: boolean) => {
    setBusy(true);
    // The service caches for a minute; "刷新" re-mounts through a fresh read.
    void api().usageStats()
      .then((value) => { if (!force || true) setStats(value); setError(null); })
      .catch((e) => setError(String((e as Error).message || e)))
      .finally(() => setBusy(false));
  };
  useEffect(() => { load(false); /* eslint-disable-line react-hooks/exhaustive-deps */ }, []);

  const maxDay = Math.max(1, ...(stats?.byDay ?? []).map((d) => d.tokens));
  const showCost = (stats?.cost ?? 0) > 0;

  return (
    <section className="pi-features__card pi-usage">
      <header className="pi-features__heading" style={{ marginBottom: 14 }}>
        <div>
          <h2 style={{ margin: 0 }}>{zh ? '本地用量统计' : 'Local usage statistics'}</h2>
          <p style={{ margin: '4px 0 0' }}>{zh ? '直接统计本机 pi 会话文件，数据不离开这台机器。' : 'Computed from local pi session files; nothing leaves this machine.'}</p>
        </div>
        <button className="pi-btn pi-btn--outline" disabled={busy} onClick={() => load(true)}>
          {busy ? (zh ? '统计中…' : 'Computing…') : zh ? '刷新' : 'Refresh'}
        </button>
      </header>
      {error && <div className="pi-features__alert" role="alert">{error}</div>}
      {!stats && !error && <p>{zh ? '正在统计…' : 'Computing…'}</p>}
      {stats && (
        <>
          <div className="pi-usage__cards">
            <div className="pi-usage__card"><small>{zh ? '会话' : 'Sessions'}</small><strong>{stats.sessions}</strong></div>
            <div className="pi-usage__card"><small>{zh ? '用户消息' : 'User msgs'}</small><strong>{stats.userMessages}</strong></div>
            <div className="pi-usage__card"><small>{zh ? '模型调用' : 'Model calls'}</small><strong>{stats.assistantMessages}</strong></div>
            <div className="pi-usage__card"><small>{zh ? '总 Tokens' : 'Total tokens'}</small><strong>{fmtTokens(stats.tokens.total)}</strong></div>
            {showCost && <div className="pi-usage__card"><small>{zh ? '总费用' : 'Total cost'}</small><strong>{fmtCost(stats.cost)}</strong></div>}
          </div>

          <div className="pi-usage__tokens">
            <span>{zh ? '输入' : 'input'} <b>{fmtTokens(stats.tokens.input)}</b></span>
            <span>{zh ? '输出' : 'output'} <b>{fmtTokens(stats.tokens.output)}</b></span>
            <span>{zh ? '缓存读' : 'cache read'} <b>{fmtTokens(stats.tokens.cacheRead)}</b></span>
            <span>{zh ? '缓存写' : 'cache write'} <b>{fmtTokens(stats.tokens.cacheWrite)}</b></span>
          </div>

          <h3>{zh ? '近 14 天' : 'Last 14 days'}</h3>
          {stats.byDay.length === 0 && <p>{zh ? '这段时间没有活动。' : 'No activity in this window.'}</p>}
          {stats.byDay.length > 0 && (
            <div className="pi-usage__days">
              {stats.byDay.map((d) => (
                <div className="pi-usage__day" key={d.day} title={`${d.day} · ${fmtTokens(d.tokens)} tokens · ${d.messages} ${zh ? '次调用' : 'calls'}`}>
                  <div className="pi-usage__bar" style={{ height: `${Math.max(4, Math.round((d.tokens / maxDay) * 72))}px` }} />
                  <span className="pi-usage__daylabel">{d.day.slice(5)}</span>
                </div>
              ))}
            </div>
          )}

          <h3>{zh ? '按模型' : 'By model'}</h3>
          <table className="pi-shortcuts__table">
            <thead>
              <tr><th>{zh ? '模型' : 'Model'}</th><th>{zh ? '调用' : 'Calls'}</th><th>{zh ? '输入' : 'In'}</th><th>{zh ? '输出' : 'Out'}</th><th>{zh ? '缓存' : 'Cache'}</th><th>{zh ? '合计' : 'Total'}</th>{showCost && <th>{zh ? '费用' : 'Cost'}</th>}</tr>
            </thead>
            <tbody>
              {stats.byModel.map((m) => (
                <tr key={`${m.provider}/${m.model}`}>
                  <td className="pi-mono">{m.provider}/{m.model}</td>
                  <td>{m.calls}</td>
                  <td>{fmtTokens(m.input)}</td>
                  <td>{fmtTokens(m.output)}</td>
                  <td>{fmtTokens(m.cacheRead + m.cacheWrite)}</td>
                  <td>{fmtTokens(m.total)}</td>
                  {showCost && <td>{fmtCost(m.cost)}</td>}
                </tr>
              ))}
            </tbody>
          </table>

          {stats.byProject.length > 0 && (
            <>
              <h3>{zh ? '按项目' : 'By project'}</h3>
              <table className="pi-shortcuts__table">
                <thead>
                  <tr><th>{zh ? '项目' : 'Project'}</th><th>{zh ? '会话' : 'Sessions'}</th><th>Tokens</th>{showCost && <th>{zh ? '费用' : 'Cost'}</th>}</tr>
                </thead>
                <tbody>
                  {stats.byProject.map((p) => (
                    <tr key={p.cwd}>
                      <td className="pi-mono" title={p.cwd}>{p.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? p.cwd}</td>
                      <td>{p.sessions}</td>
                      <td>{fmtTokens(p.tokens)}</td>
                      {showCost && <td>{fmtCost(p.cost)}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}
    </section>
  );
}
