import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorkbenchPanel } from '../src/renderer/replica/workbench/WorkbenchPanel';
import type { WorkbenchLabels, WorkbenchProps } from '../src/renderer/replica/contracts';

const labels: WorkbenchLabels = {
  review: '变更', files: '文件', browser: '浏览器', auxiliary: '辅助对话',
  homeTitle: '要打开哪个功能？', homeReview: '查看改动', homeFiles: '浏览文件',
  homeBrowser: '浏览网页', homeAuxiliary: '只读旁路对话',
  close: '关闭面板', emptyReview: '还没有变更', emptyReviewHint: '改动会显示在这里',
  emptyFiles: '打开项目后可浏览文件', emptyFilesHint: '只能浏览已打开的项目',
  emptyBrowser: '浏览器预览不可用', emptyBrowserHint: '第一阶段不加载外部页面',
  created: '新文件', selectFile: '选择文件…',
};
const base: WorkbenchProps = {
  open: true, tab: 'home', diffs: [], files: [], selectedFile: null, demo: false, labels,
  onToggle() {}, onSelectTab() {}, onSelectFile() {},
};
const html = (over: Partial<WorkbenchProps>) =>
  renderToStaticMarkup(createElement(WorkbenchPanel, { ...base, ...over }));
const auxSlot = () => createElement('section', { 'data-test': 'aux' }, 'conv');

describe('workbench home (ZCode-style function picker)', () => {
  it('renders four cards with titles and hints; aux card only when the slot exists', () => {
    const withAux = html({ sidecarPanel: auxSlot() });
    expect(withAux).toContain('要打开哪个功能？');
    expect(withAux).toContain('辅助对话');
    expect(withAux).toContain('查看改动');
    expect((withAux.match(/class="pi-workbench__homecard"/g) ?? []).length).toBe(4);
    const withoutAux = html({});
    expect((withoutAux.match(/class="pi-workbench__homecard"/g) ?? []).length).toBe(3);
    expect(withoutAux).not.toContain('只读旁路对话');
  });

  it('keeps all four tabs in the header once aux exists', () => {
    const markup = html({ tab: 'aux', sidecarPanel: auxSlot() });
    for (const label of ['变更', '文件', '浏览器', '辅助对话']) expect(markup).toContain(label);
    expect(markup).toContain('pi-workbench__auxslot');
  });

  it('aux tab without a slot shows the hint empty state; with a slot renders the keep-alive container', () => {
    const bare = html({ tab: 'aux' });
    expect(bare).toContain('只读旁路对话');
    const slotted = html({ tab: 'aux', sidecarPanel: auxSlot() });
    expect(slotted).toContain('pi-workbench__auxslot');
    expect(slotted).toContain('conv');
    // Static render cannot express cross-render keep-alive (ref flips only while tab === 'aux');
    // switching away keeps the slot mounted — covered by the browser stub (workbench-home.browser.cjs).
    const otherTab = html({ tab: 'files', sidecarPanel: auxSlot() });
    expect(otherTab).not.toContain('pi-workbench__auxslot');
  });

  it('home tab hides the regular body (only the picker shows)', () => {
    const markup = html({ tab: 'home', sidecarPanel: auxSlot() });
    expect(markup).toContain('pi-workbench__home');
    // body hidden via inline style while home picker is active
    expect(markup).toMatch(/pi-workbench__body" style="display:s*none/);
  });
});
