import { useEffect, useState } from 'react';

type CapabilityStatus = { available: boolean; source?: string };

/** 子代理能力状态展示（只读）。
 *  2026-10-18 起内置 desktop-subagent 已全删（用户二选一，避免双轨）：
 *  子代理能力完全由用户自选的 pi 扩展提供（如 npm:@wengine-ai/pi-subagents）。
 *  这里不再提供「启用内置」入口，只报告当前谁在供给。 */
export function OfficialSubagentSetup() {
  const [status, setStatus] = useState<CapabilityStatus>();
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    window.localPi.subagentCapabilityStatus()
      .then(value => { if (alive) setStatus(value); })
      .catch(e => { if (alive) setError(String((e as Error).message || e)); })
      .finally(() => { if (alive) setChecking(false); });
    return () => { alive = false; };
  }, []);

  return <section className="pi-features__card" aria-busy={checking}>
    <h2>子代理 · Subagent</h2>
    <p>支持 pi subagent 扩展的单任务、并行与串行链。任务执行时，点击对话中的「子代理」查看任务、消息、工具过程和用量。父进程重启后，未完成的子代理进度会从磁盘恢复。</p>

    {checking ? <p>正在检查…</p> : status?.available ? <>
      <p><strong>已启用：{status.source ?? '已安装的 subagent 扩展'}</strong></p>
      <p>子代理能力由该扩展提供（Desktop 内置版本已停止分发，避免双轨冲突）。第三方插件的进度持久化已通过事件层自动启用，支持崩溃恢复。</p>
      <p>子代理的子进程没有 Desktop 审批通道，只允许在完全访问模式中调用。其他模式请在设置中使用独立会话。</p>
    </> : <>
      <p><strong>未检测到 subagent 扩展。</strong></p>
      <p>安装任意 pi subagent 扩展即可启用，例如 <code>pi install @wengine-ai/pi-subagents</code>，或在「扩展」页搜索安装。安装后新建会话自动生效，无需其他配置。</p>
    </>}

    {error && <div className="pi-features__alert" role="alert">{error}</div>}
  </section>;
}
