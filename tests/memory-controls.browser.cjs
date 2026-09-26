// Synthetic component harness. Run with playwright-cli run-code --filename against Vite :5175.
async (page) => {
  const assert = (value, label) => { if (!value) throw new Error(label); };
  await page.route('http://127.0.0.1:5175/memory-test', route => route.fulfill({ contentType: 'text/html', body: '<html><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script></body></html>' }));
  await page.goto('http://127.0.0.1:5175/memory-test');
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    const { MemoryBrowser, MemorySwitch } = await import('/pi/MemoryControls.tsx');
    await import('/replica/tokens.css');
    await import('/pi/settings-features.css');
    const style = document.createElement('style');
    style.textContent = 'body{margin:0}.pireplica{min-height:100vh}.pi-features{margin:0 auto;max-width:720px!important;padding:32px 18px;box-sizing:border-box}.pi-btn{border:1px solid var(--pi-border);background:var(--pi-bg-card);color:inherit;padding:7px 12px;border-radius:7px;cursor:pointer}';
    document.head.appendChild(style);
    localStorage.removeItem('pi.memoryOpenApp');
    window.mock = { lists: [], reads: [], saves: [], opens: [] };
    window.localPi = {
      externalApps: async () => [{ id: 'finder', name: 'Finder', kind: 'finder' }, { id: 'vscode', name: 'Visual Studio Code', kind: 'editor' }, { id: 'terminal', name: 'Terminal', kind: 'terminal' }],
      memoryOpen: async (rel, cwd, appId) => { window.mock.opens.push({ rel, cwd, appId }); if (window.mock.openError) throw new Error('mock launch failure'); },
      memoryList: cwd => new Promise((resolve, reject) => window.mock.lists.push({ cwd, resolve, reject })),
      memoryRead: (rel, cwd) => new Promise((resolve, reject) => window.mock.reads.push({ rel, cwd, resolve, reject })),
      saveDesktopSettings: patch => new Promise((resolve, reject) => window.mock.saves.push({ patch, resolve, reject })),
    };
    window.file = (name, scope = 'global') => ({ name, scope, path: '/mock/' + name, rel: name, entries: 2, updatedAt: 1780000000000, bytes: 10 });
    function App() {
      const [enabled, setEnabled] = React.useState(false);
      return React.createElement('main', { className: 'pireplica' }, React.createElement('div', { className: 'pi-features' }, React.createElement('h1', null, '记忆'), React.createElement('section', { className: 'pi-features__card' }, React.createElement(MemorySwitch, { enabled, disabled: false, onSaved: setEnabled }), React.createElement(MemoryBrowser, { cwd: '/mock/current', projects: [{ name: 'Alpha', path: '/mock/alpha' }, { name: 'Beta', path: '/mock/beta' }, ...Array.from({ length: 16 }, (_, i) => ({ name: `Workspace ${i}`, path: `/mock/workspace-${i}` }))] }))));
    }
    createRoot(document.getElementById('root')).render(React.createElement(App));
  });
  const select = page.getByRole('button', { name: '记忆项目', exact: true });
  const choose = async name => { await select.click(); await page.getByRole('menuitemradio', { name, exact: true }).click(); };
  const preview = name => page.locator('.pi-memory__open').filter({ hasText: name });
  const toggle = page.getByRole('switch');
  await select.waitFor();
  assert((await select.textContent()).includes('current'), 'cwd fallback');
  await toggle.focus(); await page.keyboard.press('Space');
  assert(await toggle.isDisabled(), 'disable during save');
  await page.evaluate(() => document.querySelector('[role=switch]').click());
  assert(await page.evaluate(() => window.mock.saves.length) === 1, 'duplicate prevention');
  await page.evaluate(() => window.mock.saves[0].reject(new Error('synthetic failure')));
  await page.getByRole('alert').waitFor();
  assert(await toggle.getAttribute('aria-checked') === 'false', 'rollback');
  await toggle.focus(); await page.keyboard.press('Enter');
  await page.evaluate(() => window.mock.saves[1].resolve());
  await page.waitForFunction(() => !document.querySelector('[role=switch]').disabled);
  await choose('Alpha');
  await page.evaluate(() => { window.mock.lists[1].resolve([window.file('alpha.md'), window.file('shared.md')]); window.mock.lists[0].resolve([window.file('STALE.md')]); });
  await preview('alpha.md').click();
  assert(await page.getByText('STALE.md').count() === 0, 'stale list');
  await choose('Beta');
  await page.evaluate(() => { window.mock.reads[0].resolve('STALE PREVIEW'); window.mock.lists[2].resolve([{ ...window.file('beta.md', 'project'), rel: 'projects-external/beta.md' }, window.file('shared.md')]); });
  await preview('beta.md').click(); await preview('shared.md').click();
  await page.evaluate(() => { window.mock.reads[2].resolve('LATEST PREVIEW'); window.mock.reads[1].resolve('STALE PREVIEW'); });
  await page.getByText('LATEST PREVIEW', { exact: true }).waitFor();
  assert(await page.getByText('STALE PREVIEW', { exact: true }).count() === 0, 'preview races');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.setViewportSize({ width: 1000, height: 780 });
  await select.click();
  await page.screenshot({ path: 'output/playwright/memory-project-menu-light.png' });
  assert(await page.locator('.pi-memory-menu__items').evaluate(el => el.scrollHeight > el.clientHeight), 'scrollable projects');
  await page.keyboard.press('Home');
  assert(await page.getByRole('menuitemradio', { name: '全局记忆', exact: true }).evaluate(el => el === document.activeElement), 'Home');
  await page.keyboard.press('ArrowDown');
  assert(await page.getByRole('menuitemradio', { name: 'Alpha', exact: true }).evaluate(el => el === document.activeElement), 'ArrowDown');
  await page.keyboard.press('Escape');
  assert(await select.evaluate(el => el === document.activeElement), 'Escape focus restoration');
  await select.click(); await select.click();
  assert(await page.getByRole('menu').count() === 0, 'trigger toggles closed');
  const tools = page.getByRole('button', { name: 'beta.md 打开方式', exact: true });
  await tools.click();
  await page.screenshot({ path: 'output/playwright/memory-tools-menu-light.png' });
  assert(await page.getByRole('menuitemradio', { name: 'Terminal', exact: true }).count() === 0, 'no terminal');
  await page.keyboard.press('End'); await page.keyboard.press('Enter');
  assert(await tools.evaluate(el => el === document.activeElement), 'selection focus restoration');
  await page.waitForFunction(() => window.mock.opens.length === 1);
  assert(JSON.stringify(await page.evaluate(() => window.mock.opens[0])) === JSON.stringify({ rel: 'projects-external/beta.md', cwd: '/mock/beta', appId: 'vscode' }), 'editor file IPC');
  await tools.click(); await page.getByRole('menuitemradio', { name: 'Finder', exact: true }).click();
  await page.waitForFunction(() => window.mock.opens.length === 2);
  assert(await page.evaluate(() => window.mock.opens[1].appId === 'finder' && window.mock.opens[1].rel === 'projects-external/beta.md'), 'Finder file IPC');
  assert(await page.evaluate(() => window.mock.reads.length) === 3, 'tools do not preview');
  assert(await page.evaluate(() => window.mock.saves.length) === 2, 'does not change project default');
  await tools.click(); await page.getByRole('textbox').click();
  assert(await page.getByRole('menu').count() === 0, 'outside close');
  await page.evaluate(() => document.querySelector('.pireplica').classList.add('pireplica--dark'));
  await tools.click(); await page.screenshot({ path: 'output/playwright/memory-tools-menu-dark.png' });
  await page.keyboard.press('Escape');
  await select.click(); await page.screenshot({ path: 'output/playwright/memory-project-menu-dark.png' });
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 360, height: 800 });
  await select.click(); await page.screenshot({ path: 'output/playwright/memory-project-menu-narrow.png' });
  await page.keyboard.press('Escape');
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'narrow overflow');
  await page.evaluate(() => { window.mock.openError = true; });
  await tools.click(); await page.getByRole('menuitemradio', { name: 'Finder', exact: true }).click();
  await page.getByText(/mock launch failure/).waitFor();
  await preview('beta.md').click();
  await page.evaluate(() => window.mock.reads[3].reject(new Error('mock preview failure')));
  await page.getByText(/无法读取预览/).waitFor();
  await page.getByRole('textbox').fill('none'); await page.getByText('没有匹配的记忆文件。').waitFor();
  await page.getByRole('textbox').fill('');
  await page.getByRole('button', { name: '刷新记忆' }).click();
  await page.evaluate(() => window.mock.lists[3].reject(new Error('mock list failure')));
  await page.getByText(/无法读取记忆列表/).waitFor();
  await choose('全局记忆'); await page.evaluate(() => window.mock.lists[4].resolve([]));
  await page.getByText('此范围暂无记忆文件。').waitFor();
  assert(await toggle.getAttribute('aria-checked') === 'true', 'global switch unaffected');
  console.log('PASS: switch, races, project/tool menus, keyboard, focus, outside click, file IPC, errors, search, dark/light/narrow. Synthetic only.');
}
