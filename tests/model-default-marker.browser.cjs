// Real PiReplicaApp/SettingsPage + legacy catalog, synthetic host only; no config writes.
// Vite :5175; playwright-cli -s=model-default run-code --filename tests/model-default-marker.browser.cjs
async (page) => {
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  const url = 'http://127.0.0.1:5175/model-default-harness';
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
    const { default: App, usePiStore, ModelCatalogSection } = await import('/pi/PiReplicaApp.tsx');
    const preferences = { behavior: 'followUp', permission: 'ask', shortcuts: {}, projects: [] };
    window.persisted = {
      defaultProvider: 'alpha', defaultModel: 'a', providers: [
        { id: 'alpha', name: 'Alpha', source: 'models.json', auth: 'api_key', baseUrl: 'https://example.invalid', models: [
          { id: 'a', name: 'Same display name' }, { id: 'b', name: 'Same display name' },
          { id: 'shared/id', name: 'An intentionally very long model display name for badge visibility in narrow settings layouts' },
        ] },
        { id: 'beta', name: 'Beta', source: 'models.json', auth: 'api_key', models: [{ id: 'shared/id', name: 'Shared model from Beta' }] },
      ],
    };
    window.saves = []; window.reads = []; window.holdReads = false;
    window.localPi = {
      modelCatalog: () => {
        const snapshot = structuredClone(window.persisted);
        return new Promise((resolve, reject) => { window.reads.push({ resolve, reject, snapshot }); if (!window.holdReads) resolve(snapshot); });
      },
      modelDefaultSave: input => new Promise((resolve, reject) => window.saves.push({ input, resolve, reject })),
      environment: () => new Promise(() => {}),
      settingsSnapshot: async () => ({ preferences, ai: {}, projects: [], resources: [], mcp: [], mcpRevisions: {}, diagnostics: [], loadedExtensions: [] }),
      sessions: async () => [], runs: async () => [], archivedSessions: async () => [], onEvent: () => () => {},
      listFiles: async () => [], projectBranch: async () => null, gitStatus: async () => ({ isRepo: false, files: [] }),
    };
    window.store = usePiStore;
    usePiStore.setState({ ready: true, selectedKey: null, sessions: [], runs: [], view: 'settings', settingsPage: 'models', searchQuery: '', lang: 'zh', theme: 'light', desktopPreferences: preferences, workbenchOpen: false, catalog: undefined, catalogLoading: false, draftModelId: 'beta/shared/id', notifications: [], error: undefined });
    const root = createRoot(document.getElementById('root'));
    window.mountApp = () => flushSync(() => root.render(React.createElement(App)));
    window.mountLegacy = (lang = 'en') => {
      function Fixture() {
        const catalog = usePiStore(s => s.catalog);
        const loading = usePiStore(s => s.catalogLoading);
        return React.createElement('main', { className: 'pireplica', style: { padding: 30, display: 'block', overflow: 'auto' } }, React.createElement(ModelCatalogSection, { catalog, loading, lang, currentModel: 'beta/shared/id', onChanged: usePiStore.getState().loadCatalog }));
      }
      flushSync(() => root.render(React.createElement(Fixture)));
    };
    window.finishSave = (success = true) => {
      const save = window.saves.at(-1);
      if (!success) return save.reject(Error('mock save rejected'));
      window.persisted.defaultProvider = save.input.provider;
      window.persisted.defaultModel = save.input.model;
      save.resolve(structuredClone(window.persisted));
    };
    window.mountApp();
    await usePiStore.getState().loadCatalog();
  });
  let checks = 0;
  const assert = (ok, msg) => { if (!ok) throw Error(msg); checks++; };
  const tick = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  const row = (provider, model) => page.locator(`[data-provider-id="${provider}"][data-model-id="${model}"]`);
  const badge = () => page.locator('.pi-model-default-badge');
  const selectProvider = async name => { await page.getByRole('option', { name: new RegExp(`^${name}`) }).click(); await tick(); };
  const setDefault = async (provider, model) => { await row(provider, model).getByRole('button', { name: /设为默认|Make default/ }).click(); await tick(); };
  const finish = async success => { await page.evaluate(success => window.finishSave(success), success); await tick(); };
  const marked = async (provider, model) => {
    assert(await row(provider, model).locator('.pi-model-default-badge').count() === 1, `marked ${provider}/${model}`);
    assert(await badge().count() === 1, 'exactly one model badge in visible pane');
  };
  await marked('alpha', 'a');
  assert(await row('alpha', 'a').getByRole('button', { name: '已设为默认 · alpha / a', exact: true }).isDisabled(), 'persisted default action is disabled');
  assert(await row('alpha', 'b').getByRole('button', { name: '设为默认 · alpha / b', exact: true }).isEnabled(), 'same display name does not mark B');
  assert(await page.evaluate(() => window.saves.length) === 0, 'initial render performs no write');

  await setDefault('alpha', 'b');
  await marked('alpha', 'a');
  assert(await row('alpha', 'b').getByRole('button', { name: /设为默认/ }).isDisabled(), 'pending save disables additional model saves');
  assert(await page.evaluate(() => window.saves.at(-1).input.model) === 'b', 'save uses model ID not label');
  await finish(true);
  await marked('alpha', 'b');
  assert(await row('alpha', 'a').locator('.pi-model-default-badge').count() === 0, 'old badge removed immediately after successful reload');
  assert(await row('alpha', 'a').getByRole('button', { name: /设为默认/ }).isEnabled(), 'old action enabled again');
  await setDefault('alpha', 'a');
  const readCount = await page.evaluate(() => window.reads.length);
  await finish(false);
  await marked('alpha', 'b');
  assert(await page.evaluate(() => window.reads.length) === readCount, 'failed save does not reload or optimistically mark');
  assert(await page.evaluate(() => window.store.getState().notifications.some(n => n.title === 'mock save rejected')), 'failed save is surfaced');

  await setDefault('alpha', 'shared/id'); await finish(true); await marked('alpha', 'shared/id');
  await selectProvider('Beta');
  assert(await badge().count() === 0, 'same model ID at another provider is not a default');
  await setDefault('beta', 'shared/id'); await finish(true); await marked('beta', 'shared/id');
  assert(await page.evaluate(() => window.saves.at(-1).input.provider) === 'beta', 'cross-provider write uses exact provider ID');
  await selectProvider('Alpha');
  assert(await badge().count() === 0, 'old provider no longer marks shared model ID');

  // External persisted change followed by refresh; remount must still use catalog, not local selection.
  await page.evaluate(() => { window.persisted.defaultProvider = 'alpha'; window.persisted.defaultModel = 'a'; });
  await page.getByRole('button', { name: '刷新模型目录', exact: true }).click(); await tick();
  await marked('alpha', 'a');
  await page.evaluate(() => { window.store.setState({ settingsPage: 'general' }); }); await tick();
  await page.evaluate(() => { window.store.setState({ settingsPage: 'models' }); }); await tick();
  await marked('alpha', 'a');

  // A pre-save read must not suppress the successful save's refresh or roll it back later.
  await page.evaluate(() => { window.holdReads = true; void window.store.getState().loadCatalog(); });
  const stale = await page.evaluate(() => window.reads.length - 1);
  await setDefault('alpha', 'b'); await finish(true);
  assert(await page.evaluate(() => window.reads.length - 1) > stale, 'post-save read was not dropped behind in-flight refresh');
  await marked('alpha', 'a');
  await page.evaluate(() => window.reads.at(-1).resolve(window.reads.at(-1).snapshot)); await tick();
  await marked('alpha', 'b');
  await page.evaluate(i => window.reads[i].resolve(window.reads[i].snapshot), stale); await tick();
  await marked('alpha', 'b');
  await page.evaluate(() => { window.holdReads = false; });

  // Styling: a long name cannot clip the independent model-level badge, including min desktop width.
  await setDefault('alpha', 'shared/id'); await finish(true);
  for (const [theme, width, lang] of [['light', 1440, 'zh'], ['dark', 1440, 'en'], ['light', 960, 'en'], ['dark', 960, 'zh']]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(({ theme, lang }) => window.store.setState({ theme, lang }), { theme, lang }); await tick();
    await marked('alpha', 'shared/id');
    assert(await badge().innerText() === (lang === 'zh' ? '默认' : 'Default'), 'localized badge');
    const geometry = await badge().evaluate(el => {
      const b = el.getBoundingClientRect(), r = el.closest('[data-model-id]').getBoundingClientRect();
      const style = getComputedStyle(el);
      return { inside: b.left >= r.left && b.right <= r.right && b.right <= innerWidth && b.width > 25 && b.height > 15, nowrap: style.whiteSpace === 'nowrap', fg: style.color, bg: style.backgroundColor };
    });
    assert(geometry.inside && geometry.nowrap, `unclipped badge in ${theme}/${width}`);
    assert(geometry.fg !== geometry.bg, `contrasting badge in ${theme}`);
    await page.screenshot({ path: `output/playwright/model-default-${theme}-${width}.png` });
  }

  // Missing defaults must not inherit the currently chosen draft model.
  await page.evaluate(async () => { delete window.persisted.defaultModel; delete window.persisted.defaultProvider; await window.store.getState().loadCatalog(); }); await tick();
  assert(await badge().count() === 0, 'missing persisted pair marks no model');
  assert((await page.locator('.pi-settings__rows').first().innerText()).includes('暂无默认'), 'summary does not invent a default from session/draft');

  // Legacy/custom catalog component retained in PiReplicaApp: real component, not copied JSX.
  await page.setViewportSize({ width: 1100, height: 1000 });
  await page.evaluate(async () => { window.persisted.defaultProvider = 'alpha'; window.persisted.defaultModel = 'a'; await window.store.getState().loadCatalog(); window.mountLegacy(); }); await tick();
  await page.getByRole('button', { name: 'Alpha Default', exact: true }).click();
  await page.getByRole('button', { name: 'Beta', exact: true }).click(); await tick();
  await marked('alpha', 'a');
  assert(await badge().innerText() === 'Default', 'legacy badge localized');
  assert(await page.getByRole('combobox', { name: 'Default model', exact: true }).inputValue() === 'alpha/a', 'legacy default not current session beta/shared/id');
  await page.getByRole('combobox', { name: 'Default model', exact: true }).selectOption('alpha/b');
  await marked('alpha', 'a');
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await finish(false);
  await marked('alpha', 'a');
  assert(await page.getByRole('combobox', { name: 'Default model', exact: true }).inputValue() === 'alpha/b', 'failed legacy save preserves editable draft but not default marker');
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await finish(true);
  await marked('alpha', 'b');
  await page.getByRole('combobox', { name: 'Default model', exact: true }).selectOption('beta/shared/id');
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await finish(true);
  await marked('beta', 'shared/id');
  assert(await page.locator('option').filter({ hasText: ' · Default' }).count() === 1, 'legacy native selector marks only persisted option');
  assert(errors.length === 0, errors.join('\n'));
  return { checks, errors, writes: await page.evaluate(() => window.saves.length), host: 'synthetic only' };
}
