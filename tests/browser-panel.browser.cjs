// Synthetic component harness for the built-in browser panel (BrowserPanel).
// Real <webview> navigation needs Electron; here the webview is a plain unknown
// element and its events (did-navigate / page-title-updated / did-fail-load …)
// are dispatched synthetically. Covered: tab lifecycle, URL normalization,
// protocol rejection, nav button states, loading→stop, favicon/title updates,
// load-failure retry, viewport switch, keep-alive across tab switches.
// NOT covered (needs real Electron): actual page rendering, main-process
// will-navigate / setWindowOpenHandler guards.
// Run: playwright-cli run-code --filename tests/browser-panel.browser.cjs (Vite on :5175)
async (page) => {
  const assert = (value, label) => { if (!value) throw new Error(label); };
  await page.setViewportSize({ width: 1180, height: 820 });
  await page.route('http://localhost:5175/browser-test', route => route.fulfill({ contentType: 'text/html', body: '<html><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script></body></html>' }));
  await page.goto('http://localhost:5175/browser-test');
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    const { BrowserPanel } = await import('/pi/BrowserPanel.tsx');
    const { replicaLabels } = await import('/replica/i18n.ts');
    await import('/replica/tokens.css');
    await import('/replica/workbench/workbench.css');
    localStorage.removeItem('pi.browserViewport');
    window.calls = { loadURL: [], goBack: 0, goForward: 0, reload: 0, stop: 0 };
    window.fire = (wv, name, props) => { const e = new Event(name); Object.assign(e, props || {}); wv.dispatchEvent(e); };
    window.wire = (wv) => {
      wv.loadURL = url => { window.calls.loadURL.push(url); return Promise.resolve(); };
      wv.goBack = () => window.calls.goBack++;
      wv.goForward = () => window.calls.goForward++;
      wv.reload = () => window.calls.reload++;
      wv.stop = () => window.calls.stop++;
      wv.canGoBack = () => window.navState?.back ?? false;
      wv.canGoForward = () => window.navState?.forward ?? false;
    };
    window.renderPanel = (lang) => {
      window.__root?.unmount();
      window.__root = createRoot(document.getElementById('root'));
      window.__root.render(React.createElement('div', { className: 'pireplica' },
        React.createElement('aside', { className: 'pi-workbench', style: { width: 480, height: '100vh', borderLeft: '1px solid var(--pi-border)' } },
          React.createElement(BrowserPanel, { labels: replicaLabels(lang).browser }))));
    };
    window.renderPanel('zh');
  });
  const address = page.locator('.pi-browser__address');
  const newTabBtn = page.locator('.pi-browser__newtab');
  const webview = () => page.locator('webview');
  const back = page.getByRole('button', { name: '后退', exact: true });
  const forward = page.getByRole('button', { name: '前进', exact: true });
  const reloadBtn = () => page.getByRole('button', { name: '刷新', exact: true });
  const stopBtn = () => page.getByRole('button', { name: '停止加载', exact: true });

  // 空状态 → 新建标签页
  await page.getByText('还没有打开的标签页').waitFor();
  await page.locator('.pi-browser__btn', { hasText: '新建标签页' }).click();
  await page.getByText('在上方地址栏输入网址，回车开始浏览。').waitFor();
  assert(await page.locator('.pi-browser__tabtitle').textContent() === '新标签页', 'untitled tab');
  await page.waitForFunction(() => document.activeElement === document.querySelector('.pi-browser__address'), null, { timeout: 3000 });

  // URL 归一化：裸域名补 https://
  await address.fill('example.com');
  await address.press('Enter');
  await page.locator('webview').waitFor();
  assert((await webview().getAttribute('src')) === 'https://example.com/', 'https prepend');
  await page.evaluate(() => {
    const wv = document.querySelector('webview');
    window.wire(wv);
    window.fire(wv, 'did-start-loading');
  });
  await stopBtn().waitFor();
  await page.evaluate(() => {
    const wv = document.querySelector('webview');
    window.navState = { back: true, forward: false };
    window.fire(wv, 'did-navigate', { url: 'https://example.com/' });
    window.fire(wv, 'page-title-updated', { title: 'Example Domain' });
    window.fire(wv, 'page-favicon-updated', { favicons: ['https://example.com/favicon.ico'] });
    window.fire(wv, 'did-stop-loading');
  });
  await reloadBtn().waitFor();
  assert((await address.inputValue()) === 'https://example.com/', 'address bar follows navigation');
  await page.locator('.pi-browser__favicon').waitFor();
  await page.getByText('Example Domain').waitFor();
  assert(!(await back.isDisabled()), 'back enabled when canGoBack');
  assert(await forward.isDisabled(), 'forward disabled');
  await back.click();
  assert(await page.evaluate(() => window.calls.goBack) === 1, 'goBack invoked');
  await reloadBtn().click();
  assert(await page.evaluate(() => window.calls.reload) === 1, 'reload invoked');

  // 协议拦截：file: / javascript: 拒绝且不导航
  await address.fill('file:///etc/passwd');
  await address.press('Enter');
  await page.getByRole('alert').waitFor();
  assert((await page.getByRole('alert').textContent()).includes('仅支持 http'), 'protocol hint');
  assert((await webview().getAttribute('src')) === 'https://example.com/', 'no navigation on blocked protocol');
  await address.fill('javascript:alert(1)');
  await address.press('Enter');
  assert((await page.getByRole('alert').textContent()).includes('仅支持 http'), 'javascript: blocked');
  await address.fill('not a url');
  await address.press('Enter');
  assert((await page.getByRole('alert').textContent()).includes('有效的网址'), 'invalid url hint');

  // localhost 补 http://
  await address.fill('localhost:3000');
  await address.press('Enter');
  await page.waitForFunction(() => window.calls.loadURL.length === 0, null, { timeout: 500 }).catch(() => null);
  assert((await webview().getAttribute('src')) === 'http://localhost:3000/', 'localhost http prepend');
  await page.evaluate(() => {
    const wv = document.querySelector('webview');
    window.fire(wv, 'did-navigate', { url: 'http://localhost:3000/' });
    window.fire(wv, 'did-stop-loading');
  });
  await page.waitForFunction(() => document.querySelector('.pi-browser__address').value === 'http://localhost:3000/');

  // 同地址重输 → src 未变，走 loadURL
  await address.fill('http://localhost:3000/');
  await address.press('Enter');
  await page.waitForFunction(() => window.calls.loadURL.length === 1);
  assert((await page.evaluate(() => window.calls.loadURL[0])) === 'http://localhost:3000/', 'same-url reload via loadURL');

  // 加载失败 → 错误提示 + 重试
  await page.evaluate(() => {
    const wv = document.querySelector('webview');
    window.fire(wv, 'did-fail-load', { errorCode: -105, errorDescription: 'ERR_NAME_NOT_RESOLVED', isMainFrame: true });
  });
  await page.getByText('页面加载失败').waitFor();
  await page.getByText('ERR_NAME_NOT_RESOLVED').waitFor();
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await page.waitForFunction(() => window.calls.loadURL.length === 2);
  assert((await page.getByText('页面加载失败').count()) === 0, 'error cleared on retry');
  // ERR_ABORTED（-3）不算失败
  await page.evaluate(() => {
    const wv = document.querySelector('webview');
    window.fire(wv, 'did-stop-loading');
    window.fire(wv, 'did-fail-load', { errorCode: -3, errorDescription: 'ERR_ABORTED', isMainFrame: true });
  });
  assert((await page.getByText('页面加载失败').count()) === 0, 'ERR_ABORTED ignored');

  // 第二个标签页：切换保留 webview（display:none，不卸载）
  await newTabBtn.click();
  await address.fill('news.ycombinator.com');
  await address.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('webview').length === 2);
  await page.evaluate(() => {
    const wv = document.querySelectorAll('webview')[1];
    window.wire(wv);
    window.fire(wv, 'did-navigate', { url: 'https://news.ycombinator.com/' });
    window.fire(wv, 'page-title-updated', { title: 'Hacker News' });
    window.fire(wv, 'did-stop-loading');
  });
  await page.getByText('Hacker News').waitFor();
  assert(await page.locator('.pi-browser__tab').count() === 2, 'two tabs');
  await page.locator('.pi-browser__tabmain').first().click();
  assert((await webview().nth(0).evaluate(el => el.parentElement.style.display)) === 'block', 'first tab visible');
  assert((await webview().nth(1).evaluate(el => el.parentElement.style.display)) === 'none', 'second tab hidden but mounted');
  assert((await address.inputValue()) === 'http://localhost:3000/', 'per-tab address state');
  await page.locator('.pi-browser__tabmain').nth(1).click();
  assert((await address.inputValue()) === 'https://news.ycombinator.com/', 'switch restores address');

  // 关闭活跃 tab → 邻居接管
  await page.getByRole('button', { name: '关闭标签页: Hacker News' }).click();
  assert(await page.locator('.pi-browser__tab').count() === 1, 'tab closed');
  assert((await address.inputValue()) === 'http://localhost:3000/', 'neighbour tab activated');

  // 视口尺寸：固定 1440×900 → frame 定宽 + 尺寸徽标；localStorage 持久化
  await page.locator('.pi-browser__viewportselect').selectOption('1440x900');
  assert((await page.locator('.pi-browser__size').textContent()).includes('1440 × 900'), 'size chip');
  const frameBox = await page.locator('.pi-browser__frame').first().evaluate(el => ({ w: el.style.width, h: el.style.height }));
  assert(frameBox.w === '1440px' && frameBox.h === '900px', 'fixed frame size');
  assert((await page.evaluate(() => localStorage.getItem('pi.browserViewport'))) === '1440x900', 'viewport persisted');
  await page.locator('aside.pi-workbench').screenshot({ path: 'output/playwright/browser-panel-fixed-light.png' });
  await page.locator('.pi-browser__viewportselect').selectOption('fit');
  assert((await page.locator('.pi-browser__size').textContent()).trim() !== '—', 'fit shows actual size');
  await page.locator('aside.pi-workbench').screenshot({ path: 'output/playwright/browser-panel-light.png' });

  // 深色
  await page.evaluate(() => document.querySelector('.pireplica').classList.add('pireplica--dark'));
  await page.locator('.pi-browser__viewportselect').selectOption('1440x900');
  await page.locator('aside.pi-workbench').screenshot({ path: 'output/playwright/browser-panel-dark.png' });
  await page.evaluate(() => document.querySelector('.pireplica').classList.remove('pireplica--dark'));

  // 英文文案
  await page.evaluate(() => window.renderPanel('en'));
  await page.getByText('No tabs open').waitFor();
  await page.locator('.pi-browser__btn', { hasText: 'New tab' }).click();
  await address.fill('example.org');
  await page.getByRole('button', { name: 'Go', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('webview')?.getAttribute('src') === 'https://example.org/');
  await page.locator('aside.pi-workbench').screenshot({ path: 'output/playwright/browser-panel-en.png' });

  return 'PASS: tabs, URL normalization, protocol block, nav states, loading/stop, favicon/title, fail+retry, keep-alive switch, viewport, i18n. Synthetic events only.';
}
