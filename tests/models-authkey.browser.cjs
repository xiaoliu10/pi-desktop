// 官方供应商（pi 内核目录，source='auth'）的 API Key 设置入口：之前没有设置/修改 API Key 的地方（用户反馈）。
// 对话框：空 Key 校验、保存调用 payload、清除、oauth 供应商不显示入口（防止覆盖订阅凭证）。
// Vite at :5175; playwright-cli -s authkey open about:blank; run-code --filename tests/models-authkey.browser.cjs
async (page) => {
  const assert = (ok, label) => { if (!ok) throw new Error(label); };
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.route('http://127.0.0.1:5175/models-authkey', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<html><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script></body></html>' }));
  await page.goto('http://127.0.0.1:5175/models-authkey');
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    const { SettingsPage } = await import('/replica/settings/SettingsPage.tsx');
    const { replicaLabels } = await import('/replica/i18n.ts');
    await import('/replica/tokens.css'); await import('/replica/settings/settings.css'); await import('/pi/replica-app.css');
    const model = (id) => ({ id, name: id.toUpperCase(), contextWindow: 128000, maxTokens: 8192, input: ['text'] });
    const providers = [
      { id: 'zai-coding-cn', name: 'Z.AI Coding CN', baseUrl: '', modelCount: 2, isDefault: false, enabled: true, source: 'auth', auth: 'api_key', models: [model('glm-5.2'), model('glm-4.7')] },
      { id: 'kimi-coding', name: 'Kimi For Coding', baseUrl: '', modelCount: 1, isDefault: false, enabled: true, source: 'auth', auth: 'oauth', loginAvailable: true, models: [model('kimi-k3')] },
      { id: 'my-relay', name: 'My Relay', baseUrl: 'https://relay.example.com/v1', modelCount: 1, isDefault: false, enabled: true, source: 'models.json', auth: 'api_key', models: [model('relay-mini')] },
    ];
    const calls = [];
    window.__calls = calls;
    const props = {
      page: 'models', query: '', theme: 'light', sections: [], providers,
      providerForm: { open: false, editingId: null, name: '', baseUrl: '', apiKey: '', modelLine: '' },
      defaultModelLabel: null, demo: false, labels: replicaLabels('zh').settings,
      onBack: () => {}, onSearch: () => {}, onSelectPage: () => {}, onRowControl: () => {},
      onSetProviderForm: () => {}, onSaveProvider: () => {}, onEditProvider: () => {},
      onDeleteProvider: () => {}, onToggleProvider: () => {}, onMakeDefault: () => {}, onRefreshCatalog: () => {},
      onSaveProviderAuth: async (id, input) => { calls.push({ id, input }); },
    };
    createRoot(document.getElementById('root')).render(React.createElement('main', { className: 'pireplica' },
      React.createElement(SettingsPage, props)));
  });
  await page.locator('.pi-models-split__nav').waitFor();

  // 1) 入口可见性：auth/api_key 供应商有按钮；oauth 供应商没有；models.json 供应商没有（走编辑表单）
  await page.locator('.pi-models-split__nav button', { hasText: 'Z.AI' }).click();
  const zaiOps = await page.evaluate(() => document.querySelector('.pi-models-split__detail .pi-models-split__ops')?.textContent ?? '');
  assert(zaiOps.includes('修改 API Key'), `configured auth provider offers modify: ${zaiOps}`);
  await page.locator('.pi-models-split__nav button', { hasText: 'Kimi' }).click();
  const kimiOps = await page.evaluate(() => document.querySelector('.pi-models-split__detail .pi-models-split__ops')?.textContent ?? '');
  assert(!kimiOps.includes('API Key'), `oauth provider has no api key entry: ${kimiOps}`);
  await page.locator('.pi-models-split__nav button', { hasText: 'My Relay' }).click();
  const relayOps = await page.evaluate(() => document.querySelector('.pi-models-split__detail .pi-models-split__ops')?.textContent ?? '');
  assert(!relayOps.includes('API Key'), `editable provider keeps key in edit form: ${relayOps}`);

  // 2) 保存流程：空 Key 校验 → 填写保存 → payload 正确
  await page.locator('.pi-models-split__nav button', { hasText: 'Z.AI' }).click();
  await page.locator('.pi-models-split__detail').getByRole('button', { name: '修改 API Key' }).click();
  await page.locator('dialog.pi-provider-dialog').waitFor();
  await page.locator('dialog.pi-provider-dialog').getByRole('button', { name: '保存', exact: true }).click();
  await page.waitForTimeout(120);
  let err = await page.evaluate(() => document.querySelector('dialog.pi-provider-dialog .pi-providerform__err[role=alert]')?.textContent ?? '');
  assert(err.includes('请填写'), `empty key rejected: ${err}`);
  await page.locator('dialog.pi-provider-dialog input[type=password]').fill('sk-zai-new-key');
  await page.locator('dialog.pi-provider-dialog').getByRole('button', { name: '保存', exact: true }).click();
  await page.waitForTimeout(200);
  let calls = await page.evaluate(() => window.__calls);
  assert(calls.length === 1 && calls[0].id === 'zai-coding-cn' && calls[0].input.apiKey === 'sk-zai-new-key', `save payload: ${JSON.stringify(calls)}`);
  assert(await page.locator('dialog.pi-provider-dialog').count() === 0, 'dialog closes after save');

  // 3) 清除流程（configured 快照为 true 时才显示清除；这里直接重开对话框验证按钮与 payload）
  await page.evaluate(() => { window.__calls.length = 0; });
  await page.locator('.pi-models-split__detail').getByRole('button', { name: '修改 API Key' }).click();
  await page.locator('dialog.pi-provider-dialog').waitFor();
  await page.locator('dialog.pi-provider-dialog').getByRole('button', { name: '清除已配置' }).click();
  await page.waitForTimeout(200);
  calls = await page.evaluate(() => window.__calls);
  assert(calls.length === 1 && calls[0].input.clear === true && calls[0].input.apiKey === undefined, `clear payload: ${JSON.stringify(calls)}`);

  // 4) 无页面错误，截图存证
  assert(errors.length === 0, `page errors: ${errors.join('; ')}`);
  await page.locator('.pi-models-split__nav button', { hasText: 'Z.AI' }).click();
  await page.locator('.pi-models-split__detail').getByRole('button', { name: '修改 API Key' }).click();
  await page.locator('dialog.pi-provider-dialog').waitFor();
  await page.locator('dialog.pi-provider-dialog input[type=password]').fill('sk-preview');
  await page.screenshot({ path: 'output/playwright/models-authkey.png' });
  console.log('models-authkey: all checks passed');
}
