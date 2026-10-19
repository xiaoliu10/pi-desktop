import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Sidebar } from '../src/renderer/replica/shell/Sidebar';
import type { SidebarProps } from '../src/renderer/replica/contracts';

function render(expanded: boolean, busy: boolean) {
  return renderToStaticMarkup(createElement(Sidebar, {
    temporarySessions: [], activeSessionId: 'parent', collapsed: false, version: 'test',
    labels: { projects: '项目', sessions: '会话', search: '搜索', settings: '设置', plugins: '插件', notifications: '通知', readOnlyBadge: '只读' } as SidebarProps['labels'],
    projects: [{ id: '/x', name: 'project', path: '/x', expanded, sessions: [{ id: 'parent', title: 'parent', updatedAt: 0, source: 'desktop', busy }] }],
    onSelectSession: () => {}, onNewSession: () => {}, onToggleProject: () => {}, onToggleCollapse: () => {},
    onOpenSettings: () => {}, onOpenPlugins: () => {}, onToggleNotifications: () => {},
  }));
}
describe('project and session running indicators', () => {
  it('keeps the project indicator visible even when its running session is collapsed', () => {
    const collapsed = render(false, true);
    expect(collapsed).toContain('aria-label="项目有任务运行中"');
    expect(collapsed).not.toContain('aria-label="任务运行中"');
    const expanded = render(true, true);
    expect(expanded).toContain('aria-label="项目有任务运行中"');
    expect(expanded).toContain('aria-label="任务运行中"');
  });
  it('removes both indicators after all work ends', () => {
    expect(render(true, false)).not.toContain('pi-spinner');
  });
});
