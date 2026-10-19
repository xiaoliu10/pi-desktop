// Run with the worktree Vite server on :5187; no user sessions or files are loaded.
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
  await page.getByLabel('项目有任务运行中', { exact: true }).waitFor({ state: 'visible' });
  await page.getByLabel('任务运行中', { exact: true }).waitFor({ state: 'visible' });
  const running = await page.getByLabel('项目有任务运行中', { exact: true }).boundingBox();
  assert(running && running.width > 0 && running.height > 0, 'Project spinner must have visible size');
  await page.evaluate(() => window.__renderActivity(true, false));
  await page.getByLabel('项目有任务运行中', { exact: true }).waitFor({ state: 'visible' });
  assert(await page.getByLabel('任务运行中', { exact: true }).count() === 0, 'Collapsed session is hidden, project remains busy');
  await page.evaluate(() => window.__renderActivity(false, true));
  await page.getByLabel('项目有任务运行中', { exact: true }).waitFor({ state: 'detached' });
  assert(await page.locator('.pi-spinner').count() === 0, 'All spinners must settle on completion');
  console.log('SIDEBAR ASYNC ACTIVITY OK: expanded, collapsed, completed');
}
