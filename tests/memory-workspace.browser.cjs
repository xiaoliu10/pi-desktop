// Real MemoryBrowser + PiReplicaApp; synthetic read-only host, no real configuration/files.
// Vite :5175; playwright-cli -s=memory-workspace run-code --filename tests/memory-workspace.browser.cjs
async (page) => {
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  const url = 'http://127.0.0.1:5175/memory-workspace-harness';
  await page.route(url, route => route.fulfill({ contentType: 'text/html', body: '<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script>' }));
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.goto(url);
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    const { flushSync } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1].replace('react-dom_client.js', 'react-dom.js'))).default;
    const { MemoryBrowser } = await import('/pi/MemoryControls.tsx');
    await import('/styles.css'); await import('/replica/tokens.css'); await import('/pi/settings-features.css');
    window.lists = []; window.reads = []; window.opens = [];
    window.localPi = {
      externalApps: async () => [{ id: 'finder', name: 'Finder', kind: 'finder' }],
      memoryList: cwd => new Promise((resolve, reject) => window.lists.push({ cwd, resolve, reject })),
      memoryRead: (rel, cwd) => new Promise((resolve, reject) => window.reads.push({ rel, cwd, resolve, reject })),
      memoryOpen: async (rel, cwd, app) => { window.opens.push({ rel, cwd, app }); },
    };
    window.file = (cwd, name = 'same.md') => ({ name, rel: cwd ? `projects-external/${name}` : name, path: `${cwd ? cwd + '/.pi' : '/mock/agent'}/memory/${name}`, scope: cwd ? 'project' : 'global', entries: 2, updatedAt: Date.now() });
    const root = createRoot(document.getElementById('root'));
    window.fixtureKey = 0;
    window.mount = (cwd, reset = false) => {
      if (reset) window.fixtureKey++;
      flushSync(() => root.render(React.createElement('main', { className: 'pireplica', style: { minHeight: '100vh' } }, React.createElement('section', { className: 'pi-features', style: { padding: 20 } }, React.createElement(MemoryBrowser, { key: window.fixtureKey, cwd, globalDir: '/mock/agent/memory', projects: [{ path: '/mock/alpha', name: 'Alpha' }, { path: '/mock/beta', name: 'Beta' }] })))));
      // Capture in the prop-changing commit, not after effects/network settle.
      return { rows: document.querySelectorAll('.pi-memory__row').length, previews: document.querySelectorAll('.pi-memory__preview').length, label: document.querySelector('[aria-label="记忆项目"]')?.textContent };
    };
    window.mountApp = async state => {
      const { default: App, usePiStore } = await import('/pi/PiReplicaApp.tsx');
      window.store = usePiStore;
      const preferences = { behavior: 'followUp', permission: 'ask', shortcuts: {}, projects: [], memoryAssist: true };
      Object.assign(window.localPi, {
        settingsSnapshot: async () => ({ preferences, ai: {}, projects: [], resources: [], mcp: [], mcpRevisions: {}, diagnostics: [], loadedExtensions: [] }),
        memoryAssistStatus: async () => ({ enabled: true, plugin: { kind: 'extension', id: 'pi-memory' }, builtinDir: '/mock/custom-agent/memory', hint: '' }),
        environment: () => new Promise(() => {}), sessions: async () => [], runs: async () => [], archivedSessions: async () => [],
        onEvent: () => () => {}, listFiles: async () => [], projectBranch: async () => null,
        gitStatus: async () => ({ isRepo: false, files: [] }),
      });
      usePiStore.setState({ ready: true, selectedKey: null, sessions: [], runs: [], draftCwd: undefined, view: 'settings', settingsPage: 'memory', searchQuery: '', lang: 'zh', desktopPreferences: preferences, workbenchOpen: false, ...state });
      flushSync(() => root.render(React.createElement(App)));
    };
    window.mount(undefined);
  });
  let checks = 0;
  const assert = (ok, message) => { if (!ok) throw Error(message); checks++; };
  const tick = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const lastList = () => page.evaluate(() => window.lists.length - 1);
  const resolveList = async (id, empty = false) => { await page.evaluate(({ id, empty }) => { const r = window.lists[id]; r.resolve(empty ? [] : [window.file(r.cwd)]); }, { id, empty }); await tick(); };
  const select = async name => { await page.getByRole('button', { name: '记忆项目', exact: true }).click(); await page.getByRole('menuitemradio', { name, exact: true }).click(); await tick(); };
  const mount = async (cwd, reset = false) => { const result = await page.evaluate(({ cwd, reset }) => window.mount(cwd, reset), { cwd, reset }); await tick(); return result; };
  const preview = async () => { await page.locator('.pi-memory__open').click(); await tick(); return page.evaluate(() => window.reads.length - 1); };
  await page.waitForFunction(() => window.lists.length === 1);
  await resolveList(0);
  assert((await page.locator('.pi-memory__row').innerText()).includes('全局 · 共享'), 'initial absent cwd honestly shows global');
  const globalRead = await preview();
  const commit = await mount('/mock/alpha');
  assert(commit.label.includes('Alpha'), 'late cwd automatically selects current workspace');
  assert(commit.rows === 0 && commit.previews === 0, 'scope-changing commit has no old global rows or preview');
  assert(await page.evaluate(() => window.lists.at(-1).cwd) === '/mock/alpha', 'late cwd requests project list');
  await page.evaluate(id => window.reads[id].resolve('STALE GLOBAL PREVIEW'), globalRead); await tick();
  assert(await page.locator('.pi-memory__preview').count() === 0, 'pending global preview cannot reopen in project');
  assert(await page.locator('.pi-memory__count').innerText() === '正在加载…', 'new scope count is not inherited');
  await resolveList(await lastList());
  assert((await page.locator('.pi-memory__scope').innerText()).includes('/mock/alpha/.pi/memory'), 'scope displays exact project root');
  assert((await page.locator('.pi-memory__row').innerText()).includes('/mock/alpha/.pi/memory/same.md'), 'file displays real storage path, not inferred ownership');
  const alphaRead = await preview();
  await mount('/mock/beta');
  const betaList = await lastList();
  await resolveList(betaList);
  const betaRead = await preview();
  await page.evaluate(id => window.reads[id].resolve('BETA CURRENT'), betaRead); await tick();
  await page.evaluate(id => window.reads[id].reject(Error('STALE ALPHA ERROR')), alphaRead); await tick();
  assert(await page.locator('.pi-memory__preview pre').innerText() === 'BETA CURRENT', 'same relative filename in two projects cannot leak old preview error');
  assert(await page.getByRole('alert').count() === 0, 'old preview error is fenced');
  await select('全局记忆'); await resolveList(await lastList());
  const pinnedGlobalList = await lastList();
  await mount('/mock/alpha');
  assert(await lastList() === pinnedGlobalList, 'explicit global does not reload into later cwd');
  assert((await page.getByRole('button', { name: '记忆项目', exact: true }).innerText()).includes('全局记忆'), 'explicit global persists');
  assert((await page.locator('.pi-memory__scope').innerText()).includes('/mock/agent/memory'), 'global displays actual custom agent storage root');
  await select('Beta'); await resolveList(await lastList());
  const pinnedProjectList = await lastList();
  await mount(undefined);
  assert(await lastList() === pinnedProjectList, 'explicit project survives loss of workspace');
  await mount('/mock/alpha');
  assert(await lastList() === pinnedProjectList, 'explicit project survives later different workspace');
  await page.locator('.pi-memory__launch').click();
  assert(await page.evaluate(() => window.opens.at(-1).cwd) === '/mock/beta', 'external open uses explicitly selected scope');

  // Selecting the ALREADY selected global item must also count as an explicit choice.
  await mount(undefined, true); await resolveList(await lastList());
  await select('全局记忆');
  const sameGlobalList = await lastList();
  await mount('/mock/alpha');
  assert(await lastList() === sameGlobalList, 'explicit same-item global pins selection before cwd arrives');

  // Likewise an explicit click on the current project must stop automatic following.
  await mount('/mock/alpha', true); await resolveList(await lastList());
  await select('Alpha');
  const sameProjectList = await lastList();
  await mount('/mock/beta');
  assert(await lastList() === sameProjectList, 'explicit same-item project pins selection');

  // Global list still pending when cwd arrives: late global results must never render.
  await mount(undefined, true); const pendingGlobalList = await lastList();
  await mount('/mock/alpha'); const freshProjectList = await lastList();
  await resolveList(pendingGlobalList);
  assert(await page.locator('.pi-memory__row').count() === 0 && await page.locator('.pi-memory__count').innerText() === '正在加载…', 'late global list cannot populate or finish project load');
  await resolveList(freshProjectList);
  assert((await page.locator('.pi-memory__row').innerText()).includes('Alpha · 本地'), 'project rows badge shows the selected project name');

  // Rapid A -> B -> A: old A success and B failure must not populate new A.
  await mount('/mock/alpha', true); const oldA = await lastList();
  await mount('/mock/beta'); const oldB = await lastList();
  await mount('/mock/alpha'); const newA = await lastList();
  await resolveList(oldA);
  await page.evaluate(id => window.lists[id].reject(Error('STALE LIST ERROR')), oldB); await tick();
  assert(await page.locator('.pi-memory__row').count() === 0, 'returning to same scope does not accept earlier generation list');
  assert(await page.locator('.pi-memory__count').innerText() === '正在加载…' && await page.getByRole('alert').count() === 0, 'old list success/error/finally cannot finish latest load');
  await resolveList(newA, true);
  assert((await page.locator('.pi-memory__empty').innerText()).includes('全局记忆'), 'project empty state explains where historical global files remain');
  assert((await page.locator('.pi-memory__empty').innerText()).includes('刷新记忆'), 'project empty state has refresh guidance');
  await mount(undefined);
  assert(await page.evaluate(() => window.lists.at(-1).cwd === undefined), 'automatic mode also follows workspace clearing');
  await resolveList(await lastList(), true);
  assert((await page.locator('.pi-memory__empty').innerText()).includes('项目'), 'global empty state suggests selecting project');

  // Real app prop wiring, not a helper-only test: draft workspace must reach SettingsFeatures.
  await page.evaluate(() => window.mountApp({ draftCwd: '/mock/draft-project' }));
  await page.waitForFunction(() => window.lists.at(-1).cwd === '/mock/draft-project');
  assert(await page.evaluate(() => window.lists.at(-1).cwd) === '/mock/draft-project', 'real app draft startup selects project before a session exists');
  await resolveList(await lastList());
  assert((await page.locator('.pi-memory__scope').innerText()).includes('/mock/draft-project/.pi/memory'), 'real settings renders draft project root');
  await page.evaluate(() => window.store.setState({ selectedKey: 'late-session', sessions: [{ key: 'late-session', cwd: '/mock/session-project', name: 'fixture' }] }));
  await page.waitForFunction(() => window.lists.at(-1).cwd === '/mock/session-project');
  await resolveList(await lastList());
  assert((await page.locator('.pi-memory__scope').innerText()).includes('/mock/session-project/.pi/memory'), 'session metadata overrides draft when asynchronously available');
  await select('全局记忆'); await resolveList(await lastList());
  assert((await page.locator('.pi-memory__scope').innerText()).includes('/mock/custom-agent/memory'), 'SettingsFeatures passes backend builtinDir, not a hardcoded home path');
  const finalList = await lastList();
  await page.evaluate(() => window.store.setState({ selectedKey: null, sessions: [], draftCwd: '/mock/another-draft' })); await tick();
  assert(await lastList() === finalList, 'real app workspace updates preserve explicit global');
  await page.screenshot({ path: 'output/playwright/memory-workspace-global.png' });
  await select('another-draft'); await resolveList(await lastList());
  await page.screenshot({ path: 'output/playwright/memory-workspace-project.png' });
  assert(errors.length === 0, errors.join('\n'));
  return { checks, errors };
}
