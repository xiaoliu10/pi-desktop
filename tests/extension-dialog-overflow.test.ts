import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ExtensionDialog, InlineApprovalCard, isApprovalDialog, parseApprovalRequest } from '../src/renderer/pi/PiReplicaApp';

const base = { key: 'k1', generation: 'g1' };
const encodedTitle = [
  'Desktop 审批 · write',
  '[pi-desktop-meta]' + JSON.stringify({ name: 'parity-audit.md', dir: 'docs', add: 119, del: 4, cmd: '' }),
  '[pi-desktop-message]' + '工作目录：/mock\n变更预览：\n+ line 1\n'.repeat(200),
].join('\n');

describe('命令权限审批：ZCode 五选项内联卡（不再弹窗/抽屉）', () => {
  it('isApprovalDialog 识别 Desktop 审批 交互（含 select 新协议）', () => {
    const approval = { ...base, request: { id: 'r1', method: 'select' as const, title: encodedTitle, options: ['允许'] } };
    const select = { ...base, request: { id: 'r2', method: 'select' as const, title: 'pi extension', options: ['a', 'b'] } };
    expect(isApprovalDialog(approval)).toBe(true);
    expect(isApprovalDialog(select)).toBe(false);
  });

  it('parseApprovalRequest 拆解 title 编码：显示标题 / 工具行元数据 / diff 文档', () => {
    const parsed = parseApprovalRequest(encodedTitle);
    expect(parsed.title).toBe('Desktop 审批 · write');
    expect(parsed.meta).toMatchObject({ name: 'parity-audit.md', dir: 'docs', add: 119, del: 4 });
    expect(parsed.message).toContain('变更预览');
    // 无编码的旧 title 兜底：meta 为空、message 为空
    const plain = parseApprovalRequest('Desktop 审批 · read');
    expect(plain.title).toBe('Desktop 审批 · read');
    expect(plain.meta).toBeNull();
    expect(plain.message).toBe('');
  });

  it('五选项单选卡：允许/始终允许本项目/完全访问/拒绝/告诉模型…，默认选中「允许」', () => {
    const html = renderToStaticMarkup(createElement(InlineApprovalCard, {
      dialog: { ...base, request: { id: 'r1', method: 'select', title: encodedTitle, options: [] } },
    }));
    expect(html).toContain('需要权限');
    expect(html).toContain('parity-audit.md');
    expect(html).toContain('docs');
    expect(html).toContain('+119');
    expect(html).toContain('−4');
    expect(html).toContain('仅允许这一次');
    expect(html).toContain('后续相同文件操作不再询问');
    expect(html).toContain('授予 Agent 完全访问权限，不再确认');
    expect(html).toContain('这次先拒绝');
    expect(html).toContain('告诉模型接下来应该怎么做');
    expect(html).toContain('使用 Tab / 上下键选择，回车确认');
    expect(html).toContain('确认');
    expect(html).not.toContain('pi-overlay');
    expect(html).not.toContain('pi-approval-drawer');
    // 默认选中第一项（aria-checked=true）
    expect(html).toContain('aria-checked="true"');
  });

  it('bash 审批工具行显示命令摘要；旧 confirm 协议同样渲染内联卡', () => {
    const bashTitle = ['Desktop 审批 · bash', '[pi-desktop-meta]' + JSON.stringify({ name: 'rm -rf /tmp/x', dir: '', cmd: 'rm -rf /tmp/x' }), '[pi-desktop-message]' + '命令预览'].join('\n');
    const html = renderToStaticMarkup(createElement(InlineApprovalCard, {
      dialog: { ...base, request: { id: 'r2', method: 'confirm', title: bashTitle } },
    }));
    expect(html).toContain('rm -rf /tmp/x');
    expect(html).toContain('等待确认');
    expect(html).toContain('pi-approval-inline');
  });

  it('非审批扩展交互（select）仍走居中弹窗', () => {
    const html = renderToStaticMarkup(createElement(ExtensionDialog, {
      dialog: { ...base, request: { id: 'r3', method: 'select', title: 'pi extension', options: ['方案一', '方案二'] } },
    }));
    expect(html).toContain('pi-connectmodal__body');
    expect(html).toContain('pi-connectmodal__options');
    expect(html).toContain('方案一');
    expect(html).not.toContain('pi-approval-drawer');
  });
});
