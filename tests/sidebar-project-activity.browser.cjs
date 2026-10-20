// 侧栏运行指示的回归（用户 2026-10-19）：会话级菊花 + 项目行只做目录标识。
// 折叠项目后项目行绝不能出现第二种进度指示（运行状态是会话级，不是项目级）。
// Vite at :5187; playwright-cli run-code --filename tests/sidebar-project-activity.browser.cjs
async (page) => {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  await page.route('http://127.0.0.1:5187/sidebar-activity', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script>' }));
  await page.goto('http://127.0.0.1:5187/sidebar-activity');
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    const { Sidebar } = await import('/replica/shell/Sidebar.tsx');
    await import('/replica/tokens.css'); await import('/pi/replica-app.css');
    const element = document.getElementById('root'); element.className = 'pireplica pireplica--mac'; element.style.height = '100vh';
    const host = createRoot(element);
    window.__renderActivity = (busy, expanded) => host.render(React.createElement(Sidebar, {
      collapsed: false, activeSessionId: 'parent', temporarySessions: [], version: 'test',
      labels: { projects: '项目', sessions: '会话', search: '搜索', settings: '设置', plugins: '插件', notifications: '通知', readOnlyBadge: '只读' },
      projects: [{ id: '/x', path: '/x', name: '后台子代理项目', expanded, sessions: [{ id: 'parent', title: '等待两个子代理', updatedAt: Date.now(), source: 'desktop', busy }] }],
      onSelectSession() {}, onNewSession() {}, onToggleProject() {}, onToggleCollapse() {}, onOpenSettings() {}, onOpenPlugins() {}, onToggleNotifications() {},
    }));
    window.__renderActivity(true, true);
  });
  // 展开：会话行有菊花，项目行没有
  await page.getByLabel('任务运行中', { exact: true }).waitFor({ state: 'visible' });
  assert(await page.getByLabel('项目有任务运行中', { exact: true }).count() === 0, '项目行不得有项目级进度指示');
  assert(await page.locator('.pi-spinner').count() === 1, '只应有会话行一个菊花');
  // 折叠：项目行仍无菊花（运行状态是会话级，折叠不等于项目在转）
  await page.evaluate(() => window.__renderActivity(true, false));
  await page.waitForTimeout(80);
  assert(await page.getByLabel('任务运行中', { exact: true }).count() === 0, '折叠后会话行隐藏');
  assert(await page.locator('.pi-spinner').count() === 0, '折叠后不得出现任何菊花');
  // 完成后全部消失
  await page.evaluate(() => window.__renderActivity(false, true));
  await page.waitForTimeout(80);
  assert(await page.locator('.pi-spinner').count() === 0, '完成后不得有菊花');
  console.log('SIDEBAR ACTIVITY OK: session-level only, project row stays a folder');
}
