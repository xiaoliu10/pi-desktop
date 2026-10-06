// 侧栏折叠后的展开入口回归：折叠窄条（absolute+z-index）的展开按钮会被
// .pi-topbar 的 app-region:drag 原生层吞掉点击（无视角标），展开入口收敛到
// TopBar 内的 no-drag 按钮。断言：①折叠态 Sidebar 渲染 null（不再渲染死按钮）；
// ②TopBar 在 onExpandSidebar 存在时渲染展开按钮且点击触发回调；③undefined 时不渲染。
// Vite at :5175; playwright-cli run-code --filename tests/sidebar-toggle.browser.cjs
async (page) => {
  const assert = (ok, label) => { if (!ok) throw new Error(label); };
  await page.route('http://127.0.0.1:5175/sidebar-toggle', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script>' }));
  await page.goto('http://127.0.0.1:5175/sidebar-toggle');
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    const { Sidebar } = await import('/replica/shell/Sidebar.tsx');
    const { TopBar } = await import('/replica/shell/TopBar.tsx');
    await import('/replica/tokens.css'); await import('/replica/shell/sidebar.css'); await import('/replica/shell/topbar.css'); await import('/pi/replica-app.css');
    window.__React = React; window.__createRoot = createRoot; window.__Sidebar = Sidebar; window.__TopBar = TopBar;
  });
  await page.evaluate(() => {
    const { __React: React, __createRoot: createRoot, __Sidebar: Sidebar, __TopBar: TopBar } = window;
    const root = document.getElementById('root');
    const labels = { newSession: '新建任务', search: '搜索' };
    const sidebarBase = { projects: [], projectMenu: () => null, temporarySessions: [], collapsed: true, onToggleCollapse: () => {}, zh: true, labels };
    window.__mount = (topbarProps) => {
      root.innerHTML = '';
      createRoot(root).render(React.createElement('main', { className: 'pireplica pireplica--mac pireplica--sidebar-collapsed', style: { display: 'flex', flexDirection: 'column', height: '100vh' } },
        React.createElement(Sidebar, sidebarBase),
        React.createElement('div', { style: { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 } },
          React.createElement(TopBar, { title: 'PI Desktop', labels, onNewSession: () => {}, onOpenSearch: () => {}, ...topbarProps }),
          React.createElement('div', { style: { flex: 1 } })),
      ));
    };
  });

  // ① 折叠态 Sidebar 不渲染任何展开按钮（死按钮已移除）
  await page.evaluate(() => window.__mount({}));
  await page.waitForTimeout(80);
  const deadBtns = await page.$$eval('.pi-sidebar--collapsed button', els => els.length);
  assert(deadBtns === 0, `折叠态不应再有窄条按钮，实际 ${deadBtns} 个`);

  // ② TopBar onExpandSidebar 存在 → 渲染展开按钮，点击触发回调
  await page.evaluate(() => { window.__expanded = 0; window.__mount({ onExpandSidebar: () => { window.__expanded += 1; } }); });
  await page.waitForSelector('.pi-topbar__expand', { timeout: 5000 });
  const btn = page.locator('.pi-topbar__expand');
  const box = await btn.boundingBox();
  assert(box && box.width > 0, '展开按钮不可见');
  await btn.click();
  await page.waitForFunction(() => window.__expanded === 1, { timeout: 3000 });
  // 坐标命中自检：点击坐标处就是按钮（无遮挡）
  const hitIn = await page.evaluate(([x, y]) => { const el = document.elementFromPoint(x, y); return !!el && !!el.closest('.pi-topbar'); }, [box.x + box.width / 2, box.y + box.height / 2]);
  assert(hitIn, '按钮坐标命中异常（不在 topbar 内）');

  // ③ onExpandSidebar 缺省 → 不渲染按钮（展开态无冗余图标）
  await page.evaluate(() => window.__mount({}));
  await page.waitForTimeout(80);
  assert(await page.$('.pi-topbar__expand') === null, '未传 onExpandSidebar 不应渲染展开按钮');

  console.log('SIDEBAR TOGGLE OK');
}
