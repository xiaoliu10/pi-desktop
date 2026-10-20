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

// 运行状态是会话级属性（用户 2026-10-19 明确）：项目行只保留目录标识，
// 不聚合会话 busy——否则折叠项目时项目行一直转，会话级语义被放大成项目级。
describe('session running indicator stays session-level', () => {
  it('shows the spinner only on the running session row when the project is expanded', () => {
    const html = render(true, true);
    expect(html).toContain('aria-label="任务运行中"');
    // 项目行只有文件夹图标，没有第二种菊花/进度指示
    expect(html).not.toContain('aria-label="项目有任务运行中"');
    expect(html.match(/pi-spinner/g) ?? []).toHaveLength(1);
  });

  it('renders nothing while the project is collapsed (no session row, no project-level spinner)', () => {
    // 折叠项目时会话行不渲染，项目行也绝不能替它显示菊花——折叠 ≠ 项目在跑。
    const html = render(false, true);
    expect(html).not.toContain('pi-spinner');
    expect(html).not.toContain('aria-label="任务运行中"');
    expect(html).not.toContain('aria-label="项目有任务运行中"');
  });

  it('renders no spinner once the session finishes', () => {
    expect(render(true, false)).not.toContain('pi-spinner');
  });

  it('keeps the folder icon on the project row regardless of session state', () => {
    for (const [expanded, busy] of [[true, true], [true, false], [false, true]] as const) {
      const html = render(expanded, busy);
      expect(html).toContain('pi-sidebar__projrow');
      // 真正断言 folder 图标：Icons.tsx 的 folder path（只验容器名的话，
      // 图标被删掉而容器仍在时测试仍会通过——code-review 探针实测过）。
      expect(html).toContain('M3.5 7.2c0-1.1.9-2 2-2h3.6');
    }
  });
});
