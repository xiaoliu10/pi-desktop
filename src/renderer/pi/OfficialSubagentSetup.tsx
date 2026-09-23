import { useEffect, useRef, useState } from 'react';

type SubagentStatus = { installed: boolean; thirdParty: boolean; thirdPartySource?: string; outdated: boolean; scoutExists: boolean; path: string };

export function OfficialSubagentSetup({ onInstalled }: { onInstalled: () => Promise<void> }) {
  const [status, setStatus] = useState<SubagentStatus>();
  const [checking, setChecking] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const working = useRef(false);
  useEffect(() => {
    let alive = true;
    window.localPi.officialSubagentStatus().then(value => { if (alive) setStatus(value); }).catch(e => { if (alive) setError(String(e.message || e)); }).finally(() => { if (alive) setChecking(false); });
    return () => { alive = false; };
  }, []);

  async function install() {
    if (working.current) return; working.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const result = await window.localPi.enableOfficialSubagent();
      const fresh = await window.localPi.officialSubagentStatus();
      setStatus(fresh);
      setNotice('已启用。下次新建会话时自动加载。');
      setBusy(false);
      try { await onInstalled(); } catch { setNotice('已启用，但资源列表刷新失败。可点击页面上方"刷新"重试。'); }
    } catch (e) { setError(String((e as Error).message || e)); }
    finally { working.current = false; setBusy(false); }
  }

  const ready = status?.installed && status.scoutExists;
  const thirdParty = status?.thirdParty;
  const outdated = status?.outdated;
  const zh = true; // this component is always rendered in the zh settings page

  return <section className="pi-features__card" aria-busy={busy || checking}>
    <h2>子代理 · Subagent</h2>
    <p>支持 pi 官方 subagent 扩展的单任务、并行与串行链。任务执行时，点击对话中的"子代理"查看任务、消息、工具过程和用量。父进程重启后，未完成的子代理进度会从磁盘恢复。</p>

    {checking ? <p>正在检查安装状态…</p> : thirdParty ? <>
      <p><strong>检测到第三方 subagent 插件：{status?.thirdPartySource}</strong></p>
      <p>Desktop 不会加载内置 fallback，避免与已安装的插件冲突。第三方插件的进度持久化已通过事件层自动启用（支持崩溃恢复）。</p>
      <p>如需切换回 Desktop 内置版本，请在扩展管理中停用 <code>{status?.thirdPartySource}</code> 后新建会话。</p>
    </> : ready ? <>
      <p>正在使用 Desktop 内置 subagent（fallback）。在完全访问模式下自动生效，无需手动启用。</p>
      {outdated && <p style={{ color: 'var(--pi-orange-text)' }}>检测到旧版扩展残留（{status?.path}），已在后台自动迁移。新建会话后生效。</p>}
      <p>子代理的子进程没有 Desktop 审批通道，只允许在完全访问模式中调用。其他模式请在设置中使用独立会话。</p>
      <div className="pi-features__actions">
        <button className="pi-btn pi-btn--outline" disabled={busy} onClick={() => void install()}>重新安装 / 修复</button>
      </div>
    </> : <>
      <p>尚未启用 subagent 支持。启用后新建会话即可使用。</p>
      <div className="pi-features__actions">
        <button className="pi-btn pi-btn--primary" disabled={busy} onClick={() => void install()}>{busy ? '正在启用…' : '启用 subagent'}</button>
      </div>
    </>}

    {error && <div className="pi-features__alert" role="alert">{error}</div>}
    {notice && <div className="pi-features__notice" role="status">{notice}</div>}
  </section>;
}
