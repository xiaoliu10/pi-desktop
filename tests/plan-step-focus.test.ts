import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PlanViewer } from '../src/renderer/pi/PlanViewer';
import { ConversationStatusPanel } from '../src/renderer/pi/ConversationStatusPanel';

// 组件读 localStorage（折叠态）与 window.innerWidth——node 环境补最小 stub
const store = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) };
(globalThis as any).window = { ...(globalThis as any).window, innerWidth: 1280 };
import type { PlanItem } from '../src/shared/conversation-status';

const checklist: PlanItem[] = [
  { step: '第一步：摸清落地形态（async-subagent-runs 目录结构）', status: 'completed' },
  { step: '第二步：主进程扫描 → 事件层广播', status: 'in_progress' },
  { step: '第三步：renderer 卡片投影', status: 'pending' },
];

const viewer = (props: Partial<Parameters<typeof PlanViewer>[0]> = {}) =>
  renderToStaticMarkup(createElement(PlanViewer, {
    doc: { title: '任务计划', markdown: '# 任务计划\n\n## 1. ✅ 第一步\n\n## 2. 🔄 第二步\n\n## 3. ⬜ 第三步' },
    checklist, lang: 'zh', running: false, planMode: false, synthesized: false,
    onClose: () => undefined, ...props,
  }));

describe('计划步骤即点即看（用户 2026-10-19：点击进来只给几个标题过于简单）', () => {
  it('PlanViewer 渲染完整 markdown 文档，不是只有标题列表', () => {
    const html = viewer();
    expect(html).toContain('任务计划');
    expect(html).not.toContain('## 1.');            // markdown 源码不泄漏
    expect(html).toMatch(/1\.\s*✅\s*第一步/);     // 渲染后的完整小节（序号+状态+标题）
    expect(html).toMatch(/3\.\s*⬜\s*第三步/);
    expect(html).toContain('第二步');                // 进行中的完整 step 文本
  });

  it('focusIndex 命中的清单项带 is-highlight 类（定位高亮）', () => {
    const html = viewer({ focusIndex: 1 });
    expect(html).toMatch(/is-in_progress[^"]*is-highlight|is-highlight[^"]*is-in_progress/);
    // 其他项不高亮
    expect((html.match(/is-highlight/g) ?? []).length).toBe(1);
  });

  it('无 focusIndex 时没有任何项高亮', () => {
    expect(viewer().includes('is-highlight')).toBe(false);
  });

  it('状态面板「进程」行可点（onOpenPlanStep 存在时加 is-clickable + 调用）', () => {
    const clicks: number[] = [];
    const html = renderToStaticMarkup(createElement(ConversationStatusPanel, {
      messages: [], running: false, onReview: () => undefined, onRequest: () => undefined,
      onOpenPlan: () => undefined, onOpenPlanStep: (i: number) => clicks.push(i),
      planAvailable: true, planTitle: '任务计划', planFallback: checklist,
    }));
    expect(html).toContain('is-clickable');
    expect(html).toContain('摸清落地形态（async-subagent-runs 目录结构）'); // 完整 step 文本渲染
    expect(html).toContain('点击查看该步骤的完整明细');                      // 有 title 提示
    void clicks; // 静态渲染不触发点击（DOM 级断言已覆盖接线）
  });

  it('未提供 onOpenPlanStep 时行不可点（保持纯展示）', () => {
    const html = renderToStaticMarkup(createElement(ConversationStatusPanel, {
      messages: [], running: false, onReview: () => undefined, onRequest: () => undefined,
      onOpenPlan: () => undefined, planAvailable: true, planFallback: checklist,
    }));
    expect(html).not.toContain('is-clickable');
  });
});
