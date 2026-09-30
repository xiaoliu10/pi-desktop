// Run model-context-server.mjs, then playwright-cli run-code --filename this file.
// Real App -> dialog -> host draft -> actual writer/temp models.json -> pinned runtime.
async (page) => {
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  const base = 'http://127.0.0.1:5186';
  const url = base + '/context-harness';
  await page.route(url, route => route.fulfill({ contentType: 'text/html', body: '<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script>' }));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(url);
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const clientPath = entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1];
    const { createRoot } = (await import(clientPath)).default;
    const { flushSync } = (await import(clientPath.replace('react-dom_client.js', 'react-dom.js'))).default;
    await import('/styles.css');
    const { default: App, usePiStore } = await import('/pi/PiReplicaApp.tsx');
    const preferences = { behavior: 'followUp', permission: 'ask', shortcuts: {}, projects: [] };
    window.api = async (op, body) => {
      const response = await fetch('/__context/' + op, { method: 'POST', body: JSON.stringify(body || {}) });
      const value = await response.json(); if (!response.ok) throw Error(value.error); return value;
    };
    await window.api('reset');
    window.localPi = {
      modelCatalog: () => window.api('catalog'), modelProviderSave: draft => window.api('save', draft),
      environment: () => new Promise(() => {}),
      settingsSnapshot: async () => ({ preferences, ai: {}, projects: [], resources: [], mcp: [], mcpRevisions: {}, diagnostics: [], loadedExtensions: [] }),
      sessions: async () => [], runs: async () => [], archivedSessions: async () => [], onEvent: () => () => {},
      listFiles: async () => [], projectBranch: async () => null, gitStatus: async () => ({ isRepo: false, files: [] }),
    };
    window.store = usePiStore;
    usePiStore.setState({ ready: true, selectedKey: null, sessions: [], runs: [], view: 'settings', settingsPage: 'models', searchQuery: '', lang: 'zh', theme: 'light', desktopPreferences: preferences, workbenchOpen: false, catalog: undefined, catalogLoading: false, notifications: [], error: undefined });
    const root = createRoot(document.getElementById('root'));
    flushSync(() => root.render(React.createElement(App)));
    await usePiStore.getState().loadCatalog();
  });
  let checks = 0;
  const assert = (ok, msg) => { if (!ok) throw Error(msg); checks++; };
  const row = page.locator('[data-provider-id="alpha"][data-model-id="shared"]');
  await row.waitFor();
  assert((await row.innerText()).includes('1,000,000'), 'initial upstream context is 1m');
  await row.getByRole('button', { name: '编辑模型 shared', exact: true }).click();
  const dialog = page.getByRole('dialog');
  assert(await dialog.locator('[name="contextWindow"]').inputValue() === '1000000', 'actual edit form reads 1m');
  await dialog.locator('[name="contextWindow"]').fill('200000');
  // Concurrent external update after opening the editor, before saving.
  await page.evaluate(() => window.api('external'));
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => window.store.getState().catalog.providers.find(p => p.id === 'alpha').models.find(m => m.id === 'shared').contextWindow === 200000);
  assert((await row.innerText()).includes('200,000'), 'saved row is 200k');
  const state = await page.evaluate(() => window.api('inspect'));
  assert(state.saves.length === 1, 'one actual write');
  assert(JSON.stringify(state.saves[0].modelEdit.fields) === '["contextWindow"]', 'only context changed');
  assert(state.saves[0].models.length === 1 && !state.saves[0].apiKey, 'no full provider replay/secrets');
  assert(state.doc.providers.alpha.models[0].contextWindow === 200000, 'actual temp models.json definition is 200k');
  assert(state.doc.providers.alpha.modelOverrides.shared.contextWindow === 200000, 'runtime override is 200k');
  assert(state.effective === 200000 && state.upstream === 1000000, 'fresh pinned runtime effective 200k vs upstream 1m');
  assert(state.doc.providers.alpha.apiKey === 'rotated-fixture' && state.doc.providers.alpha.extra === 'external', 'external provider changes preserved');
  assert(state.doc.providers.alpha.headers.keep === 'fixture-header' && state.doc.providers.alpha.models[0].unknown.keep, 'headers and unknown model fields preserved');
  assert(state.doc.providers.alpha.models.some(m => m.id === 'externally-added'), 'concurrently added model preserved');
  assert(state.doc.providers.beta.models[0].contextWindow === 1000000, 'same ID other provider remains 1m');
  await page.getByRole('button', { name: '刷新模型目录', exact: true }).click();
  await row.getByRole('button', { name: '编辑模型 shared', exact: true }).click();
  assert(await dialog.locator('[name="contextWindow"]').inputValue() === '200000', 'reopened actual editor after refresh reads 200k');
  await dialog.locator('[name="name"]').fill('Renamed only');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  const again = await page.evaluate(() => window.api('inspect'));
  assert(again.effective === 200000, 'later name-only edit retains effective 200k');
  assert(JSON.stringify(again.saves[1].modelEdit.fields) === '["name"]', 'name-only edit does not replay context');
  await page.evaluate(() => window.store.setState({ settingsPage: 'general' }));
  await page.evaluate(() => window.store.setState({ settingsPage: 'models' }));
  await row.getByRole('button', { name: '编辑模型 shared', exact: true }).click();
  assert(await dialog.locator('[name="contextWindow"]').inputValue() === '200000', 'remounted page retains 200k');
  await dialog.locator('[name="contextWindow"]').fill('16000');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  assert((await dialog.getByRole('alert').innerText()).includes('最大输出'), 'invalid output/context combination blocked');
  assert((await page.evaluate(() => window.api('inspect'))).saves.length === 2, 'invalid save never reaches disk');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await page.screenshot({ path: 'output/playwright/model-context-200k.png' });
  assert(errors.length === 0, errors.join('\n'));
  return { checks, errors, effective: again.effective, upstream: again.upstream, storage: 'mkdtemp fixture only' };
}
