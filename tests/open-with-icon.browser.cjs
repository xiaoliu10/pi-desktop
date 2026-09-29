// 打开方式按钮改图标形态（用户反馈：只展示图标，文字进下拉列表）：点击图标弹下拉，
// 列表内选应用 = 用它打开当前项目并记住偏好；打开失败错误留在面板内且菜单不关。
// Vite at :5175; playwright-cli -s owicon open about:blank; run-code --filename tests/open-with-icon.browser.cjs
async (page) => {
  const assert = (ok, l) => { if (!ok) throw new Error(l); };
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.setViewportSize({ width: 900, height: 600 });
  await page.route('http://127.0.0.1:5175/ow-icon', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<html><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script></body></html>' }));
  await page.goto('http://127.0.0.1:5175/ow-icon');
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    const { OpenWithMenu } = await import('/pi/OpenWithMenu.tsx');
    const { usePiStore } = await import('/pi/PiReplicaApp.tsx');
    await import('/replica/tokens.css'); await import('/pi/replica-app.css');
    window.__calls = { openWith: [], saved: [] };
    window.localPi = {
      externalApps: async () => [
        { id: 'finder', name: 'Finder', kind: 'finder' },
        { id: 'vscode', name: 'VS Code', kind: 'editor' },
        { id: 'iterm', name: 'iTerm', kind: 'terminal' },
      ],
      openWith: async (cwd, appId) => { window.__calls.openWith.push({ cwd, appId }); if (appId === 'boom') throw new Error('无法打开'); },
      saveDesktopSettings: async (patch) => { window.__calls.saved.push(patch); return patch; },
      settingsSnapshot: async () => ({ preferences: { openWithApp: window.__calls.saved.at(-1)?.openWithApp } }),
    };
    createRoot(document.getElementById('root')).render(React.createElement('main', { className: 'pireplica', style: { padding: 40 } },
      React.createElement(OpenWithMenu, { cwd: '/proj', lang: 'zh' })));
    void usePiStore;
  });
  await page.locator('.pi-openwith__iconbtn').waitFor();

  // 1) 触发器只显示图标：无文字
  const trigger = await page.evaluate(() => {
    const b = document.querySelector('.pi-openwith__iconbtn');
    return { text: b.textContent.trim(), hasVisual: !!b.querySelector('img,svg'), noCaret: !document.querySelector('.pi-openwith__caret, .pi-openwith__split') };
  });
  assert(trigger.text === '', `trigger is icon-only (no text): "${trigger.text}"`);
  assert(trigger.hasVisual && trigger.noCaret, `app icon shown, split button gone: ${JSON.stringify(trigger)}`);
  // ZCode 样式：可见边框 + 内边距 + 下拉小箭头（此前被 .pireplica button 重置吃掉）
  const style = await page.evaluate(() => {
    const b = document.querySelector('.pi-openwith__iconbtn');
    const cs = getComputedStyle(b);
    return { border: cs.borderTopWidth, padding: cs.padding, h: Math.round(b.getBoundingClientRect().height), chevron: !!b.querySelector('.pi-openwith__chevron') };
  });
  assert(style.border !== '0px', `visible border: ${style.border}`);
  assert(style.padding !== '0px', `padding present: ${style.padding}`);
  assert(style.h >= 24 && style.h <= 36, `button height in topbar range: ${style.h}`);
  assert(style.chevron, `chevron-down indicator present`);

  // 2) 点击图标 → 下拉列表展示应用名
  await page.locator('.pi-openwith__iconbtn').click();
  await page.locator('.pi-openwith__menu').waitFor();
  const menu = await page.evaluate(() => [...document.querySelectorAll('.pi-openwith__menu button')].map(b => b.textContent.trim()));
  assert(menu.length === 3 && menu.some(t => t.includes('Finder')) && menu.some(t => t.includes('VS Code')), `apps listed in menu: ${JSON.stringify(menu)}`);

  // 3) 选 VS Code → openWith + 记住偏好 + 菜单关闭
  await page.locator('.pi-openwith__menu button', { hasText: 'VS Code' }).click();
  await page.waitForTimeout(250);
  let calls = await page.evaluate(() => window.__calls);
  assert(calls.openWith.length === 1 && calls.openWith[0].appId === 'vscode' && calls.openWith[0].cwd === '/proj', `openWith called: ${JSON.stringify(calls.openWith)}`);
  assert(calls.saved.length === 1 && calls.saved[0].openWithApp === 'vscode', `preference saved: ${JSON.stringify(calls.saved)}`);
  assert(await page.locator('.pi-openwith__menu').count() === 0, 'menu closes after pick');

  // 4) 打开失败：错误留在面板内，菜单不关
  await page.evaluate(() => {
    window.__calls.openWith.length = 0;
    const prev = window.localPi.openWith;
    window.localPi.openWith = async (cwd, appId) => { if (appId === 'iterm') throw new Error('无法打开'); return prev(cwd, appId); };
  });
  await page.locator('.pi-openwith__iconbtn').click();
  await page.locator('.pi-openwith__menu').waitFor();
  await page.locator('.pi-openwith__menu button', { hasText: 'iTerm' }).click();
  await page.waitForTimeout(250);
  const failed = await page.evaluate(() => ({
    err: document.querySelector('.pi-openwith__menu [role="alert"]')?.textContent ?? null,
    menuOpen: !!document.querySelector('.pi-openwith__menu'),
  }));
  assert(failed.err?.includes('无法打开'), `error shown inside panel: ${failed.err}`);
  assert(failed.menuOpen, `menu stays open on failure`);

  assert(errors.length === 0, `page errors: ${errors.join('; ')}`);
  await page.screenshot({ path: 'output/playwright/open-with-icon.png' });
}
