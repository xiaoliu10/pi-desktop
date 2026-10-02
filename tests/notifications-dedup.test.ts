import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePiStore } from '../src/renderer/pi/adapter';
import { Notifications } from '../src/renderer/replica/overlays/Overlays';
import type { NotificationItem, NotificationsLabels } from '../src/renderer/replica/contracts';

// 通知列表的长列表治理：相同通知（压缩/插入等高频事件）合并计数不刷屏；
// 渲染层列表独立滚动（头/底注钉住）+ ×N 徽标。
describe('通知列表：合并与滚动', () => {
  const listeners: Array<(e: unknown) => void> = [];
  const localPi = {
    onEvent: (fn: (e: unknown) => void) => { listeners.push(fn); return () => undefined; },
    settingsSnapshot: vi.fn(async () => ({ preferences: { behavior: 'followUp', permission: 'ask', shortcuts: {}, projects: [] }, ai: {}, resources: [], mcp: [], mcpRevisions: {}, diagnostics: [], projects: [], loadedExtensions: [] })),
    environment: vi.fn(async () => ({ supported: true, version: '0.99.1' })),
    sessions: vi.fn(async () => []),
    runs: vi.fn(async () => []),
    archivedSessions: vi.fn(async () => []),
    history: vi.fn(async () => ({ session: {}, entries: [], branch: [], leaves: [], leafId: null, syncedAt: 0 })),
    recoverSubagents: vi.fn(async () => []),
  };
  beforeAll(() => {
    (globalThis as Record<string, unknown>).window = { localPi };
    (globalThis as Record<string, unknown>).localStorage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
    usePiStore.getState().init();
  });
  beforeEach(() => usePiStore.setState({ notifications: [] } as never));

  it('相同通知合并为一条并计数，时间刷新、置顶', () => {
    const s = () => usePiStore.getState();
    s().notify({ kind: 'info', title: 'pi 正在压缩上下文', time: '刚刚' });
    s().notify({ kind: 'info', title: 'pi 正在压缩上下文', time: '刚刚' });
    s().notify({ kind: 'success', title: '已插入当前任务，将在当前步骤结束后生效', time: '刚刚' });
    s().notify({ kind: 'info', title: 'pi 正在压缩上下文', time: '刚刚' });
    const list = s().notifications;
    expect(list.length).toBe(2);
    const merged = list.find((n) => n.title === 'pi 正在压缩上下文')!;
    expect(merged.count).toBe(3);
    // 合并条目更新到最前
    expect(list[0]!.count).toBe(3);
    expect(list[1]!.title).toBe('已插入当前任务，将在当前步骤结束后生效');
    // 未读角标按条目算，不被重复刷高
    expect(list.filter((n) => !n.read).length).toBe(2);
  });

  it('kind 或正文不同的通知不合并', () => {
    const s = () => usePiStore.getState();
    s().notify({ kind: 'info', title: '出错', body: 'A', time: '刚刚' });
    s().notify({ kind: 'error', title: '出错', body: 'A', time: '刚刚' });
    s().notify({ kind: 'info', title: '出错', body: 'B', time: '刚刚' });
    expect(s().notifications.length).toBe(3);
    expect(s().notifications.every((n) => (n.count ?? 1) === 1)).toBe(true);
  });

  it('渲染：列表独立滚动容器 + ×N 徽标', () => {
    const labels: NotificationsLabels = { title: '通知', markAllRead: '全部标为已读', empty: '暂无通知', request: '请求', demoNote: '来自本地 pi 的事件通知。', copy: '复制', copied: '已复制', dismiss: '删除', clearAll: '清空' };
    const items: NotificationItem[] = [
      { id: 'a', kind: 'info', title: 'pi 正在压缩上下文', time: '刚刚', read: false, count: 3 },
      { id: 'b', kind: 'success', title: '已插入当前任务，将在当前步骤结束后生效', time: '刚刚', read: false },
    ];
    const html = renderToStaticMarkup(createElement(Notifications, {
      open: true, items, labels, onClose: () => undefined, onMarkAllRead: () => undefined, onSelect: () => undefined,
    }));
    expect(html).toContain('pi-notif__list'); // 独立滚动容器
    expect(html).toContain('×3'); // 合并计数徽标
    expect(html).not.toContain('×1'); // count=1 不显示徽标
  });

  it('删除：dismissNotification 只移除目标条，未读数随之减少', () => {
    const s = () => usePiStore.getState();
    s().notify({ kind: 'info', title: 'A', time: '刚刚' });
    s().notify({ kind: 'error', title: 'B', time: '刚刚' });
    s().notify({ kind: 'success', title: 'C', time: '刚刚' });
    const target = s().notifications[1]!; // 中间那条
    expect(s().notifications.filter((n) => !n.read).length).toBe(3);
    s().dismissNotification(target.id);
    const list = s().notifications;
    expect(list.length).toBe(2);
    expect(list.some((n) => n.id === target.id)).toBe(false);
    expect(list.map((n) => n.title)).toEqual(['C', 'A']); // 其余两条保持原序
    expect(s().notifications.filter((n) => !n.read).length).toBe(2);
  });

  it('清空：clearNotifications 一次清空全部', () => {
    const s = () => usePiStore.getState();
    s().notify({ kind: 'info', title: 'A', time: '刚刚' });
    s().notify({ kind: 'error', title: 'B', time: '刚刚' });
    s().clearNotifications();
    expect(s().notifications.length).toBe(0);
  });

  it('渲染：提供 onDismiss/onClearAll 时展示删除与清空控件', () => {
    const labels: NotificationsLabels = { title: '通知', markAllRead: '全部标为已读', empty: '暂无通知', request: '请求', demoNote: '', copy: '复制', copied: '已复制', dismiss: '删除', clearAll: '清空' };
    const items: NotificationItem[] = [{ id: 'a', kind: 'info', title: 'T', time: '刚刚', read: false }];
    const base = { open: true, items, labels, onClose: () => undefined, onMarkAllRead: () => undefined, onSelect: () => undefined };
    const withActions = renderToStaticMarkup(createElement(Notifications, { ...base, onDismiss: () => undefined, onClearAll: () => undefined }));
    expect(withActions).toContain('清空'); // 头部清空按钮
    expect(withActions).toContain('删除'); // 行尾删除按钮（aria-label）
    const without = renderToStaticMarkup(createElement(Notifications, { ...base }));
    expect(without).not.toContain('清空'); // 缺省不渲染
  });
});
