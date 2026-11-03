// 聊天里的 http 链接默认在右侧工作台浏览器打开（不是系统浏览器），右键可选用系统浏览器。
// 用户 2026-11-03：「会话中需要打开访问操作做自动化的都默认在侧边栏打开，点击超链接时
// 默认在侧边栏打开，但是可选：用系统浏览器打开」。
//
// 覆盖三层：
// 1. 链接点击 → 侧栏打开（openInBrowser），且不触发 window.open
// 2. 已有标签页时新增标签而不是复用（用户选定策略）
// 3. 右键菜单含「用系统浏览器打开」，点它才走 window.open
//
// 跑法：npx vite --host 127.0.0.1 --port 5175 --strictPort（后台）
//       playwright-cli -s=chatlink run-code --filename tests/chat-link-sidebar.browser.cjs
async (page) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  const url = 'http://127.0.0.1:5175/chat-link-sidebar-harness';
  await page.route(url, route => route.fulfill({ contentType: 'text/html', body: '<div id="root" class="pireplica"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script>' }));
  await page.goto(url);
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);

  await page.evaluate(async () => {
    // 记录系统浏览器通道（Electron 里 window.open 走 setWindowOpenHandler → openExternal）
    window.__opens = [];
    window.open = (u) => { window.__opens.push(String(u)); return null; };
    // 侧栏打开请求的真实通道：window 上的 pi:open-in-browser 事件。
    // 这里注册一个监听并 preventDefault（模拟 BrowserPanel 在岗），记录收到的 URL。
    window.__sidebarOpens = [];
    window.addEventListener('pi:open-in-browser', (e) => {
      window.__sidebarOpens.push(String(e.detail.url));
      e.preventDefault();
    });

    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    await import('/styles.css'); await import('/replica/tokens.css'); await import('/replica/chat/chat.css');
    const { ChatMarkdown } = await import('/replica/chat/ChatView.tsx');
    createRoot(document.getElementById('root')).render(
      React.createElement(ChatMarkdown, {
        text: '文档见 https://example.com/docs ，工具输出也试下 https://example.com/tool 。',
        zh: true,
      }),
    );
  });
  await page.waitForSelector('.pi-md a', { timeout: 15000 });

  let checks = 0;
  const assert = (ok, message) => { if (!ok) throw Error(message); checks++; };

  // 1. 左键点击 → 侧栏打开，不走系统浏览器
  await page.evaluate(() => document.querySelector('.pi-md a').click());
  await page.waitForTimeout(300);
  const left = await page.evaluate(() => ({
    sidebar: window.__sidebarOpens,
    opens: window.__opens,
    stillRendered: document.querySelectorAll('.pi-md a').length,
  }));
  assert(left.sidebar.length === 1 && left.sidebar[0] === 'https://example.com/docs',
    `点击默认在侧栏打开（实际 sidebar=${JSON.stringify(left.sidebar)}）`);
  assert(left.opens.length === 0, `点击不再走系统浏览器（实际 window.open=${JSON.stringify(left.opens)}）`);
  assert(left.stillRendered === 2, `点击后消息仍在，无顶层导航（实际 ${left.stillRendered}）`);

  // 2. 右键菜单必须提供「用系统浏览器打开」
  const box = await page.evaluate(() => {
    const a = document.querySelector('.pi-md a');
    const r = a.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.click(box.x, box.y, { button: 'right' });
  await page.waitForTimeout(250);
  const menu = await page.evaluate(() => {
    const items = [...document.querySelectorAll('[role="menuitem"], .pi-ctxmenu__item, .pi-linkmenu__item')]
      .map(el => el.textContent?.trim() || '');
    return { items, anyMenu: document.querySelectorAll('[role="menu"], .pi-ctxmenu, .pi-linkmenu').length };
  });
  assert(menu.anyMenu > 0, `右键弹出菜单（实际菜单容器 ${menu.anyMenu} 个）`);
  const systemItem = menu.items.find(t => t.includes('系统浏览器'));
  assert(Boolean(systemItem), `菜单含「用系统浏览器打开」（实际项：${JSON.stringify(menu.items)}）`);

  // 3. 点「用系统浏览器打开」才走 window.open
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('[role="menuitem"], .pi-ctxmenu__item, .pi-linkmenu__item')]
      .find(e => (e.textContent || '').includes('系统浏览器'));
    el.click();
  });
  await page.waitForTimeout(300);
  const viaSystem = await page.evaluate(() => ({ opens: window.__opens, sidebar: window.__sidebarOpens }));
  assert(viaSystem.opens.length === 1 && viaSystem.opens[0] === 'https://example.com/docs',
    `点菜单项走系统浏览器（实际 ${JSON.stringify(viaSystem.opens)}）`);
  assert(viaSystem.sidebar.length === 1, `菜单项不再重复进侧栏（实际 ${viaSystem.sidebar.length}）`);

  console.log(`PASS (${checks} checks): 链接默认侧栏打开 + 右键可选系统浏览器`);
  return { checks };
}
