import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SettingsPage } from '../src/renderer/replica/settings/SettingsPage';
import type { SettingsProps } from '../src/renderer/replica/contracts';

const labels = { general: '通用', shortcuts: '快捷键', backToApp: '返回应用', searchSettings: '搜索设置', emptyGeneric: '', emptyGenericHint: '', appearance: '外观', ai: 'AI', instructions: '指令', models: '模型', skills: '技能', mcp: 'MCP', extensions: '扩展', subagents: '子代理', import: '导入', projects: '项目', archived: '归档', usage: '数据', info: '关于' } as unknown as SettingsProps['labels'];

function render(page: SettingsProps['page'], pageContent?: React.ReactNode) {
  const props = {
    page, query: '', theme: 'light', sections: [], providers: [],
    providerForm: { saving: false, open: false, editingId: null, name: '', baseUrl: '', apiKey: '', modelLine: '', models: undefined },
    defaultModelLabel: null, vendorEmpty: '', catalogInfo: '', demo: false, labels,
    onBack: () => {}, onSearch: () => {}, onSelectPage: () => {},
    onRowControl: () => {}, onSetProviderForm: () => {},
    onSaveProvider: () => {}, onEditProvider: () => {}, onDeleteProvider: () => {},
    onToggleProvider: () => {}, onMakeDefault: () => {}, onRefreshCatalog: () => {},
    pageContent,
  } as unknown as SettingsProps;
  return renderToStaticMarkup(h(SettingsPage, props));
}

describe('SettingsPage nav click → content switch', () => {
  it('lists 快捷键 in the nav', () => {
    expect(render('general')).toContain('快捷键');
  });
  it('renders passed pageContent for shortcuts (PiReplicaApp passes SettingsFeatures)', () => {
    const html = render('shortcuts', h('div', { id: 'features' }, 'FEATURES'));
    expect(html).toContain('FEATURES');
    expect(html).not.toContain('主题');
  });
  it('falls back to empty hint when pageContent missing', () => {
    const html = render('shortcuts');
    expect(html).toContain('通用界面'); // emptyGeneric hint
  });
});
