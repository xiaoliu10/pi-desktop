// 侧栏折叠后左上切换图标点击无效回归：collapsed 浮动窄条（z-index:20）与
// .pi-topbar 的 -webkit-app-region:drag 命中竞争。app-region 拦截发生在原生层，
// 无视 CSS z-index——需真实 mouse.click 验证（elementFromPoint 不反映 app-region）。
// Vite at :5175; playwright-cli run-code --filename tests/sidebar-toggle-hit.browser.cjs
async (page) => {
  const assert = (ok, label) => { if (!ok) throw new Error(label); };
  await page.route('http://127.0.0.1:5175/sidebar-hit', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script>' }));
  await page.goto('http://127.0.0.1:5175/sidebar-hit');
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    await import('/replica/tokens.css');
    await import('/pi/replica-app.css');
    await import('/replica/shell/sidebar.css');
    await import('/replica/shell/topbar.css');
    let clicks = 0;
    window.__clicks = () => clicks;
    window.__toggle = () => { clicks += 1; };
    document.getElementById('root').innerHTML = `
      <main class="pireplica pireplica--mac pireplica--sidebar-collapsed" style="display:flex;flex-direction:column;height:100vh">
        <aside class="pi-sidebar pi-sidebar--collapsed">
          <button class="pi-iconbtn" onclick="window.__toggle()" aria-label="展开侧边栏"><svg width="16" height="16"></svg></button>
        </aside>
        <div style="flex:1;display:flex;flex-direction:column;min-width:0">
          <header class="pi-topbar"><span>TopBar 内容（drag 区）</span></header>
          <div style="flex:1">chat content</div>
        </div>
      </main>`;
  });
  await page.waitForTimeout(100);
  const info = await page.evaluate(() => {
    const btn = document.querySelector('.pi-sidebar--collapsed .pi-iconbtn');
    const r = btn.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    const topbar = document.querySelector('.pi-topbar').getBoundingClientRect();
    return { btnRect: { x: Math.round(cx), y: Math.round(cy) }, hitTag: hit.className || hit.tagName, inTopbarBox: cy < topbar.bottom, topbarBottom: Math.round(topbar.bottom) };
  });
  console.log('HIT-INFO', JSON.stringify(info));
  // 真实鼠标点击（走 CDP input，会被 app-region 拦截）
  await page.mouse.click(info.btnRect.x, info.btnRect.y);
  await page.waitForTimeout(120);
  const clicks = await page.evaluate(() => window.__clicks());
  console.log('CLICKS-AFTER-REAL-MOUSE:', clicks);
  assert(clicks >= 1, `真实点击未触发展开按钮（clicks=${clicks}）——点击被 topbar 的 app-region:drag 原生层吃掉`);
  console.log('SIDEBAR TOGGLE HIT OK');
}
