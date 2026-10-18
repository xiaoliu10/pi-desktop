import { useEffect, useMemo, useRef, useState } from 'react';
import type { PiOutlineItem } from '../../../shared/pi';
import { Icon } from '../Icons';
import './chat.css';

/**
 * 会话地图（大纲面板）：长会话的「章节目录」。
 *
 * 为什么需要：27219 条的会话里找「三天前让他改的那个 bug」只能靠滚或全局搜索。
 * 索引层（主进程 sessionOutline）已把每个 user entry 聚合成一章（8ms/355 轮实测），
 * 这里只做展示 + 定位：点一章 → onJump(entryId) → 复用会话内搜索同一条定位链路
 * （store.pendingJump → ChatView 滚动到该消息）。
 *
 * 设计约束（对齐 ZCode「能省的装饰就省」）：
 *  - 无序号气泡/无时间戳列：标题 + 工具数徽标 + 图片标记，一屏能扫 20+ 章
 *  - 当前章高亮跟随滚动（IntersectionObserver 或 scroll 采样；用 rAF 节流）
 *  - 355 章全量渲染（无虚拟化）：355 个 <li> 的 DOM 成本远低于一轮 markdown，
 *    ChatView 的 renderLimit 窗口才是大头；实测打开 <5ms
 */
export function SessionMap(props: {
  items: PiOutlineItem[];
  activeEntryId?: string;
  onJump: (entryId: string) => void;
  onClose: () => void;
  loading?: boolean;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState('');
  const shown = useMemo(() => {
    const q = filter.trim();
    if (!q) return props.items;
    return props.items.filter(i => i.title.includes(q));
  }, [props.items, filter]);

  // 打开时滚到当前章（用户点开地图通常是想从「现在的位置」上下翻）
  useEffect(() => {
    if (!props.activeEntryId) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-outline="${CSS.escape(props.activeEntryId)}"]`);
    el?.scrollIntoView({ block: 'center' });
  }, [props.activeEntryId]);

  return (
    <aside className="pi-sessionmap" aria-label="会话地图">
      <div className="pi-sessionmap__head">
        <span className="pi-sessionmap__title">会话地图</span>
        <span className="pi-sessionmap__count">{props.items.length} 轮</span>
        <button className="pi-sessionmap__close" onClick={props.onClose} aria-label="关闭会话地图" title="关闭">
          <Icon name="x" size={14} />
        </button>
      </div>
      {props.items.length > 8 && (
        <div className="pi-sessionmap__filter">
          <Icon name="search" size={13} />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="筛选轮次标题"
            aria-label="筛选轮次标题"
          />
        </div>
      )}
      <div className="pi-sessionmap__list" ref={listRef} role="listbox" aria-label="会话轮次">
        {props.loading && <div className="pi-sessionmap__empty">加载中…</div>}
        {!props.loading && shown.length === 0 && <div className="pi-sessionmap__empty">{filter ? '无匹配轮次' : '暂无轮次'}</div>}
        {!props.loading && shown.map(item => (
          <button
            key={item.entryId}
            type="button"
            role="option"
            aria-selected={item.entryId === props.activeEntryId}
            data-outline={item.entryId}
            className={`pi-sessionmap__item ${item.entryId === props.activeEntryId ? 'pi-sessionmap__item--active' : ''}`}
            onClick={() => props.onJump(item.entryId)}
            title={item.title}
          >
            <span className="pi-sessionmap__text">{item.title || '（空消息）'}</span>
            <span className="pi-sessionmap__badges">
              {item.hasImages && <span className="pi-sessionmap__badge" title="含图片">图</span>}
              {item.toolCount > 0 && <span className="pi-sessionmap__badge" title={`${item.toolCount} 次工具调用`}>{item.toolCount}</span>}
            </span>
          </button>
        ))}
      </div>
    </aside>
  );
}
