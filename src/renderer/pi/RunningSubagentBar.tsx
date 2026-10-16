import { Icon } from '../replica/Icons';
import type { SubagentChild } from './subagents';
import { runningSubagents } from './subagents';

/**
 * 主对话里的「运行中子代理」持续提示条。
 *
 * 存在的理由：子代理进度原先只在侧边状态面板与右侧详情面板可见，两者都可能被
 * 用户收起/关闭。后台子代理在跑而主对话已经回复结束时，用户看不到任何还在工作
 * 的信号——既不知道要等，也会在切换会话或断开时无意中杀掉子代理。
 *
 * 设计对齐 ZCode 的可观测口径（chat.summaryPanel.openRunningSubagentSession /
 * conversationShare.error.activeSubagent）：主对话必须能感知 activeSubagent。
 * 这里做成一条可点击的横条，点击打开右侧子代理面板；不自动抢焦点、不遮挡输入。
 */
export function RunningSubagentBar({ subagents, onOpen }: { subagents: SubagentChild[]; onOpen: () => void }) {
  const live = runningSubagents(subagents);
  if (!live.length) return null;
  const names = [...new Set(live.map(c => c.agent || '子代理'))].slice(0, 3).join('、');
  const more = new Set(live.map(c => c.agent)).size > 3 ? ' 等' : '';
  return (
    <div className="pi-subagent-bar" role="status" aria-live="polite">
      <span className="pi-subagent-bar__icon"><Icon name="loader" size={14} /></span>
      <span className="pi-subagent-bar__text">
        <b>{live.length}</b> 个子代理正在工作 · {names}{more}
      </span>
      <button type="button" className="pi-subagent-bar__action" onClick={onOpen}>
        查看进度<Icon name="chevron-right" size={12} />
      </button>
    </div>
  );
}
