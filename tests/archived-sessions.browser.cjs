// Synthetic component mock; Vite on 127.0.0.1:5175.
// playwright-cli -s=archived-sessions run-code --filename tests/archived-sessions.browser.cjs
async (page) => {
  const assert = (ok, label) => { if (!ok) throw new Error(label); };
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.setViewportSize({ width: 900, height: 760 });
  await page.route('http://127.0.0.1:5175/archived-test', route => route.fulfill({ contentType: 'text/html', body: '<html><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script></body></html>' }));
  await page.goto('http://127.0.0.1:5175/archived-test');
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    const { ArchivedSessions } = await import('/pi/ArchivedSessions.tsx');
    const { usePiStore } = await import('/pi/adapter.ts');
    await import('/replica/tokens.css'); await import('/pi/settings-features.css'); await import('/pi/replica-app.css');
    const style = document.createElement('style');
    style.textContent = 'body{margin:0}.pireplica{min-height:100vh;background:var(--pi-bg);color:var(--pi-text)}.pi-features{margin:0 auto;max-width:720px!important;padding:32px 18px;box-sizing:border-box}';
    document.head.appendChild(style);
    window.mock = { saves: [], deletes: [], confirms: [], confirmResult: true };
    window.confirm = msg => { window.mock.confirms.push(msg); return window.mock.confirmResult; };
    window.localPi = {
      saveDesktopSettings: patch => new Promise((resolve, reject) => window.mock.saves.push({ patch, resolve, reject })),
      deleteArchivedSession: key => new Promise((resolve, reject) => window.mock.deletes.push({ key, resolve, reject })),
    };
    window.store = usePiStore;
    usePiStore.setState({
      lang: 'zh',
      archivedKeys: ['k-old', 'k-new'],
      sessions: [
        { key: 'k-old', id: 'k-old', path: '/sessions/old.jsonl', cwd: '/work/alpha', name: '旧的重构任务', updatedAt: 1780000000000, size: 10, warnings: [], owned: true },
        { key: 'k-new', id: 'k-new', path: '/sessions/new.jsonl', cwd: '/work/beta', name: '新的接口联调', updatedAt: 1780000100000, size: 10, warnings: [], owned: true },
      ],
      renames: {},
      desktopPreferences: { behavior: 'followUp', permission: 'ask', shortcuts: {}, projects: [] },
      error: undefined,
    });
    createRoot(document.getElementById('root')).render(React.createElement('main', { className: 'pireplica' }, React.createElement('div', { className: 'pi-features' }, React.createElement(ArchivedSessions, { embedded: true }))));
  });
  const card = page.locator('.pi-archive-autodelete');
  const toggle = card.getByRole('checkbox');
  const select = card.getByRole('combobox');
  await card.waitFor();
  assert(await toggle.isChecked() === false, 'auto-delete off by default');
  assert(await select.isDisabled(), 'retention disabled while off');
  assert((await card.innerText()).includes('永久删除'), 'permanent-deletion copy visible');
  // 开启开关 → 立即保存
  await toggle.click();
  await page.waitForFunction(() => window.mock.saves.length === 1);
  assert(JSON.stringify(await page.evaluate(() => window.mock.saves[0].patch)) === JSON.stringify({ autoDeleteArchived: true }), 'toggle saves immediately');
  await page.evaluate(() => window.mock.saves[0].resolve());
  await page.waitForFunction(() => !document.querySelector('.pi-archive-autodelete select').disabled);
  // 修改保留天数 → 立即保存
  await select.selectOption('90');
  await page.waitForFunction(() => window.mock.saves.length === 2);
  assert(JSON.stringify(await page.evaluate(() => window.mock.saves[1].patch)) === JSON.stringify({ autoDeleteArchivedDays: 90 }), 'days saved immediately');
  await page.evaluate(() => window.mock.saves[1].resolve());
  // 取消删除 → 不调 IPC
  await page.evaluate(() => { window.mock.confirmResult = false; });
  await page.getByRole('button', { name: '删除', exact: true }).first().click();
  assert(await page.evaluate(() => window.mock.deletes.length) === 0, 'cancel does not delete');
  assert((await page.evaluate(() => window.mock.confirms.at(-1))).includes('废纸篓'), 'confirm mentions Trash');
  // 确认删除 → 调 IPC → 行消失
  await page.evaluate(() => { window.mock.confirmResult = true; });
  await page.getByRole('button', { name: '删除', exact: true }).first().click();
  await page.waitForFunction(() => window.mock.deletes.length === 1);
  assert(await page.evaluate(() => window.mock.deletes[0].key) === 'k-old', 'delete IPC key');
  await page.evaluate(() => window.mock.deletes[0].resolve(['k-new']));
  await page.waitForFunction(() => window.store.getState().archivedKeys.length === 1);
  assert(await page.getByText('旧的重构任务').count() === 0, 'deleted row disappears');
  assert(await page.getByText('新的接口联调').count() === 1, 'other row stays');
  await page.getByRole('button', { name: '删除', exact: true }).waitFor();
  await page.screenshot({ path: 'output/playwright/archived-autodelete-zh.png' });
  // 英文文案 + 深色
  await page.evaluate(() => {
    window.store.setState({ lang: 'en', desktopPreferences: { ...window.store.getState().desktopPreferences, autoDeleteArchived: true, autoDeleteArchivedDays: 90 } });
    document.querySelector('.pireplica').classList.add('pireplica--dark');
  });
  assert((await card.innerText()).includes('permanently deleted'), 'english permanent copy');
  await page.screenshot({ path: 'output/playwright/archived-autodelete-en-dark.png' });
  // 保存失败 → 本地状态回滚 + 错误可见
  await select.selectOption('180');
  await page.waitForFunction(() => window.mock.saves.length === 3);
  await page.evaluate(() => window.mock.saves[2].reject(new Error('mock save failure')));
  await card.getByRole('alert').waitFor();
  assert(await select.inputValue() === '90', 'days rollback on save failure');
  // 删除失败 → 错误提示，行保留
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.waitForFunction(() => window.mock.deletes.length === 2);
  await page.evaluate(() => window.mock.deletes[1].reject(new Error('mock delete failure')));
  await page.getByRole('alert').filter({ hasText: 'mock delete failure' }).waitFor();
  assert(await page.getByText('新的接口联调').count() === 1, 'failed delete keeps row');
  assert(errors.length === 0, errors.join('\n'));
  console.log('PASS: toggle/days immediate save, save-failure rollback, confirm gating, trash copy, delete IPC + list refresh, failure keeps row, zh/en + dark screenshots. Synthetic only.');
}
