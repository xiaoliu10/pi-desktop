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
    for (const item of items) expect(doc!.markdown).toContain(item.step);
    expect(doc!.markdown).toContain('✅ 已完成');
    expect(doc!.markdown).toContain('🔄 进行中');
    expect(doc!.markdown).toContain('⬜ 待处理');
    // 每步一个二级小节（表格单元格塞不下多行 step——2026-10-19 改为小节形态）
    expect(doc!.markdown).toContain('## 1. ✅ 已完成');
    expect(doc!.markdown).toContain('## 2. 🔄 进行中');
    expect(doc!.markdown).toContain('## 3. ⬜ 待处理');
  });
  it('returns null for an empty checklist (keep the honest empty state)', () => {
    expect(planDocumentFromChecklist([], 'zh')).toBeNull();
  });
  it('keeps multi-line steps intact in section form (no content loss)', () => {
    const doc = planDocumentFromChecklist([{ step: '第一步：定义问题\n- 子项 A\n- 子项 B', status: 'pending' }], 'zh');
    // 小节形态：换行与列表结构原样保留（此前表格形态把 \n 压成空格，明细丢失）
    expect(doc!.markdown).toContain('第一步：定义问题\n- 子项 A\n- 子项 B');
    expect(doc!.markdown).not.toContain('| 状态 |');
  });
  it('english locale', () => {
    const doc = planDocumentFromChecklist(items, 'en');
    expect(doc!.title).toBe('Task plan');
    expect(doc!.markdown).toContain('Progress: 1/3 completed');
  });
});
