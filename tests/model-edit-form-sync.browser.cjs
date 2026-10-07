// 供应商表单内模型编辑的持久化回归（用户报障：改上下文窗口/最大输出重启后被改写）。
// 历史 bug：表单内铅笔入口无 providerId → ModelMetadataDialog 保存只写本地表单草稿
//（无 IPC 无提示）→ 用户以为已保存 → 重启回退。修复后该入口即时走 modelEdit IPC，
// 且保存成功后同步表单草稿——否则「保存提供商」用陈旧 draft.models 覆盖磁盘（P1 回归）。
// Vite at :5175; playwright-cli run-code --filename tests/model-edit-form-sync.browser.cjs
async (page) => {
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  const assert = (ok, label) => { if (!ok) throw new Error(label + ' | pageerrors: ' + errors.join(' ;; ')); };
  await page.route('http://127.0.0.1:5175/model-edit-form-sync', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script>' }));
  await page.goto('http://127.0.0.1:5175/model-edit-form-sync');
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    const { SettingsPage } = await import('/replica/settings/SettingsPage.tsx');
    await import('/replica/tokens.css'); await import('/pi/replica-app.css'); await import('/replica/settings/settings.css');
    window.__h = { React, createRoot, SettingsPage };
  });
  await page.evaluate(() => {
    const { React, createRoot, SettingsPage } = window.__h;
    const calls = { modelProviderSave: [], setForm: [] };
    window.__calls = calls;
    let form = { open: true, editingId: 'testprov', name: 'Test', baseUrl: 'https://x/v1', apiKey: '', modelLine: '', models: [{ id: 'm1', contextWindow: 128000, maxTokens: 32000 }], saving: false, error: undefined };
    const rerender = () => {
      createRoot(document.getElementById('root')).render(React.createElement(SettingsPage, {
        page: 'models', query: '', theme: 'dark', sections: [], providers: [],
        providerForm: form,
        defaultModelLabel: null, vendorEmpty: '', catalogInfo: '', demo: false,
        labels: { backToApp: '返回', searchSettings: '搜索', modelConfiguration: '模型配置', aiProviders: '模型供应商', providerFormEdit: '编辑提供商', providerFormTitle: '添加提供商', providerModels: '模型', providerName: '名称', providerBaseUrl: 'Base URL', providerApiKey: 'API Key', cancel: '取消', nameRequired: '必填', defaults: '默认', defaultModel: '默认模型', noDefault: '未设置' },
        onBack: () => {}, onSearch: () => {}, onSelectPage: () => {},
        providerForm_set: undefined,
        onSetProviderForm: (patch) => { form = { ...form, ...patch }; calls.setForm.push(JSON.parse(JSON.stringify(form))); rerender(); },
        onSaveProvider: () => {
          // 模拟 PiReplicaApp.saveProvider：发送当前表单草稿的 models（陈旧与否是关键断言）
          calls.modelProviderSave.push({ id: form.editingId, models: JSON.parse(JSON.stringify(form.models ?? [])) });
        },
        onSaveProviderModel: async (providerId, model, originalId, fields) => {
          calls.modelProviderSave.push({ id: providerId, modelEdit: { originalId, kind: 'custom', fields }, models: [JSON.parse(JSON.stringify(model))] });
        },
        infoExtra: null, pageContent: undefined, modelCatalogSection: null,
      }));
    };
    window.__rerender = rerender;
    rerender();
  });
  await page.waitForSelector('[aria-label="编辑模型 m1"]', { timeout: 15000 });

  // ① 表单内点铅笔 → ModelMetadataDialog 打开
  await page.click('[aria-label="编辑模型 m1"]');
  await page.waitForSelector('dialog[open] input[name="contextWindow"]', { timeout: 5000 });

  // ② 改上下文窗口 → 保存
  await page.fill('input[name="contextWindow"]', '400000');
  await page.click('dialog button[type="submit"]');

  // ③ 断言：modelEdit IPC 被调（即时持久化）+ 表单草稿同步到 400000（P1）
  await page.waitForFunction(() => window.__calls.modelProviderSave.some(c => c.modelEdit), { timeout: 5000 });
  const editCall = await page.evaluate(() => window.__calls.modelProviderSave.find(c => c.modelEdit));
  assert(editCall.modelEdit.fields.includes('contextWindow'), 'fields 缺 contextWindow: ' + JSON.stringify(editCall.modelEdit.fields));
  assert(editCall.models[0].contextWindow === 400000, '提交模型 cw=' + editCall.models[0].contextWindow);
  const draftModels = await page.evaluate(() => window.__calls.setForm.at(-1)?.models);
  assert(draftModels?.[0]?.contextWindow === 400000, '表单草稿未同步: ' + JSON.stringify(draftModels));

  // ④ 模拟「保存提供商」（用同步后的草稿）→ 断言不回退（P1 回归点）
  await page.evaluate(() => { const f = window.__calls.setForm.at(-1); window.__calls.modelProviderSave.push({ id: f.editingId, models: JSON.parse(JSON.stringify(f.models)) }); });
  const finalSave = await page.evaluate(() => window.__calls.modelProviderSave.at(-1));
  assert(finalSave.models[0].contextWindow === 400000, '保存提供商回退了编辑: ' + JSON.stringify(finalSave.models));

  console.log('MODEL EDIT FORM SYNC OK');
}
