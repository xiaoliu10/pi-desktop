import { describe, expect, it } from 'vitest';
import { planDocumentFromChecklist } from '../src/renderer/pi/plan-document';
import type { PlanItem } from '../src/shared/conversation-status';

const items: PlanItem[] = [
  { step: 'Phase 0/1: 问题定义 + 项目内部摸底', status: 'completed' },
  { step: 'Phase 2: 4 个调研 subagent 全部交付（task-3 超时后 resume 补救）', status: 'in_progress' },
  { step: 'Phase 4: 完成 docs/design/memory-consolidation.md，自检并交付', status: 'pending' },
];

describe('planDocumentFromChecklist', () => {
  it('synthesizes a reviewable markdown document from the checklist', () => {
    const doc = planDocumentFromChecklist(items, 'zh');
    expect(doc).not.toBeNull();
    expect(doc!.title).toBe('任务计划');
    expect(doc!.markdown).toContain('# 任务计划');
    expect(doc!.markdown).toContain('进度：1/3 已完成');
    expect(doc!.markdown).toContain('| 状态 | 计划项 |');
    for (const item of items) expect(doc!.markdown).toContain(item.step);
    expect(doc!.markdown).toContain('✅ 已完成');
    expect(doc!.markdown).toContain('🔄 进行中');
    expect(doc!.markdown).toContain('⬜ 待处理');
  });
  it('returns null for an empty checklist (keep the honest empty state)', () => {
    expect(planDocumentFromChecklist([], 'zh')).toBeNull();
  });
  it('escapes table-breaking characters in steps', () => {
    const doc = planDocumentFromChecklist([{ step: 'a | b\nc', status: 'pending' }], 'zh');
    expect(doc!.markdown).toContain('a \\| b c');
    // 仍是单行表格行：换行被折叠
    expect(doc!.markdown.split('\n').filter(l => l.startsWith('| ✅') || l.startsWith('| 🔄') || l.startsWith('| ⬜'))).toHaveLength(1);
  });
  it('english locale', () => {
    const doc = planDocumentFromChecklist(items, 'en');
    expect(doc!.title).toBe('Task plan');
    expect(doc!.markdown).toContain('Progress: 1/3 completed');
    expect(doc!.markdown).toContain('| Status | Plan item |');
  });
});
