import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  InlineAskCard,
  isAskDialog,
  parseAskPayload,
  pendingAttentionBySession,
} from '../src/renderer/pi/PiReplicaApp';
import { Sidebar } from '../src/renderer/replica/shell/Sidebar';
import type { Dialog } from '../src/renderer/pi/adapter';
import type { SessionNavItem, SidebarProps } from '../src/renderer/replica/contracts';

const askDialog = (key: string, id: string): Dialog => ({
  key,
  generation: 'g1',
  request: {
    id,
    method: 'input',
    title: 'desktop-ask',
    placeholder: JSON.stringify({
      questions: [
        { header: '实现方案', question: '采用哪种持久化方式？', options: [{ label: 'SQLite' }, { label: 'JSON' }] },
      ],
    }),
  },
});

const permissionDialog = (key: string, id: string): Dialog => ({
  key,
  generation: 'g1',
  request: { id, method: 'confirm', title: 'Desktop 审批 · write', message: '工作目录：/x' },
});

describe('会话级阻塞交互（ask_user_question 不再跨会话弹窗）', () => {
  it('pendingAttentionBySession 按会话聚合，userInput 优先于 permission', () => {
    const attention = pendingAttentionBySession([
      permissionDialog('k1', 'p1'),
      askDialog('k2', 'a1'),
      permissionDialog('k2', 'p2'),
      permissionDialog('k3', 'p3'),
    ]);
    expect(attention.k1).toEqual({ needsConfirm: 'permission', needsConfirmCount: 1 });
    expect(attention.k2).toEqual({ needsConfirm: 'userInput', needsConfirmCount: 2 });
    expect(attention.k3).toEqual({ needsConfirm: 'permission', needsConfirmCount: 1 });
    expect(attention.k4).toBeUndefined();
  });

  it('isAskDialog 只认 desktop-ask 且 payload 可解析', () => {
    expect(isAskDialog(askDialog('k1', 'a1'))).toBe(true);
    expect(isAskDialog(permissionDialog('k1', 'p1'))).toBe(false);
    expect(isAskDialog({
      key: 'k1', generation: 'g1',
      request: { id: 'bad', method: 'input', title: 'desktop-ask', placeholder: 'not json' },
    })).toBe(false);
  });

  it('InlineAskCard 渲染为对话流内联卡（无全局遮罩），取消/提交走 answerDialog', () => {
    const html = renderToStaticMarkup(createElement(InlineAskCard, { dialog: askDialog('k1', 'a1') }));
    expect(html).toContain('pi-ask-inline');
    expect(html).toContain('实现方案');
    expect(html).toContain('SQLite');
    expect(html).not.toContain('pi-overlay');
    expect(html).not.toContain('"pi-connectmodal"');
  });

  it('ask 卡 payload 损坏时不渲染（不挡对话）', () => {
    const html = renderToStaticMarkup(createElement(InlineAskCard, {
      dialog: { key: 'k1', generation: 'g1', request: { id: 'x', method: 'input', title: 'desktop-ask', placeholder: 'oops' } },
    }));
    expect(html).toBe('');
  });

  it('侧栏行展示「待用户确认」胶囊并替换时间位（ZCode TaskInteractionBadge 语义）', () => {
    const session: SessionNavItem = {
      id: 'k2', title: '实施计划', updatedAt: Date.now(), source: 'desktop',
      needsConfirm: 'userInput', needsConfirmCount: 2,
    };
    const labels = {
      projects: '项目', sessions: '会话', search: '搜索', settings: '设置', plugins: '插件',
      notifications: '通知', readOnlyBadge: '只读',
    } as unknown as SidebarProps['labels'];
    const html = renderToStaticMarkup(createElement(Sidebar, {
      projects: [], temporarySessions: [session], activeSessionId: null, collapsed: false,
      version: 'pi 0', labels,
      onSelectSession: () => {}, onNewSession: () => {}, onToggleProject: () => {},
      onToggleCollapse: () => {}, onOpenSettings: () => {}, onOpenPlugins: () => {},
      onToggleNotifications: () => {},
    } satisfies SidebarProps));
    expect(html).toContain('pi-sidebar__confirm--userInput');
    expect(html).toContain('待用户确认');
    expect(html).toContain('×2');
    // 胶囊替换时间位：确认态不再同时显示相对时间
    expect(html).not.toContain('pi-sidebar__time');
  });

  it('无阻塞交互的会话照常显示时间位', () => {
    const session: SessionNavItem = { id: 'k1', title: '普通会话', updatedAt: Date.now(), source: 'desktop' };
    const labels = {
      projects: '项目', sessions: '会话', search: '搜索', settings: '设置', plugins: '插件',
      notifications: '通知', readOnlyBadge: '只读',
    } as unknown as SidebarProps['labels'];
    const html = renderToStaticMarkup(createElement(Sidebar, {
      projects: [], temporarySessions: [session], activeSessionId: null, collapsed: false,
      version: 'pi 0', labels,
      onSelectSession: () => {}, onNewSession: () => {}, onToggleProject: () => {},
      onToggleCollapse: () => {}, onOpenSettings: () => {}, onOpenPlugins: () => {},
      onToggleNotifications: () => {},
    } satisfies SidebarProps));
    expect(html).not.toContain('pi-sidebar__confirm');
    expect(html).toContain('pi-sidebar__time');
  });
});
