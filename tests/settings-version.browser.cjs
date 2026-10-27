// 设置 → 关于：版本号必须是真实 Desktop 版本（由调用方传入），
// 不得硬编码 0.1.0-desktop 占位串（issue #168）。
// 跑法：playwright-cli -s=chatlink run-code --filename tests/settings-version.browser.cjs
async (page) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  const url = 'http://127.0.0.1:5175/settings-version-harness';
  await page.route(url, route => route.fulfill({ contentType: 'text/html', body: '<div id="root" class="pireplica"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script>' }));
  await page.goto(url);
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    await import('/styles.css'); await import('/replica/tokens.css'); await import('/replica/settings/settings.css');
    const { SettingsPage } = await import('/replica/settings/SettingsPage.tsx');
    const labels = {};
    const base = { general: 'general', about: '关于', version: '版本', runtime: '运行时', demoEnv: 'demo env', noVendor: '', save: 'save', close: 'close' };
    Object.assign(labels, base);
    createRoot(document.getElementById('root')).render(
      React.createElement(SettingsPage, {
        page: 'info', query: '', theme: 'light', sections: [], providers: [],
        providerForm: { vendor: 'custom', baseUrl: '', apiKey: '', models: '' },
        defaultModelLabel: null, vendorEmpty: '', catalogInfo: '', demo: false,
        labels, onBack: () => {}, onSearch: () => {}, onSelectPage: () => {}, onRowControl: () => {},
        appVersion: '0.1.36',
      }),
    );
  });
  await page.waitForSelector('.pi-mono', { timeout: 15000 });
  const versions = await page.evaluate(() => [...document.querySelectorAll('.pi-mono')].map(e => e.textContent));
  if (!versions.includes('0.1.36')) throw Error(`未显示真实版本 0.1.36（实际 ${JSON.stringify(versions)}）`);
  if (versions.some(v => v === '0.1.0-desktop')) throw Error('仍含硬编码 0.1.0-desktop 占位串');
  console.log('PASS: 设置页显示真实 Desktop 版本，无硬编码占位串');
  return {};
}
