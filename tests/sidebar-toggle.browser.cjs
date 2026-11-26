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
    function Shell() {
      const [collapsed, setCollapsed] = React.useState(false);
      const toggle = () => setCollapsed(value => !value);
      return React.createElement('main', {
        className: 'pireplica pireplica--mac' + (collapsed ? ' pireplica--sidebar-collapsed' : ''),
        style: { display: 'flex', height: '100vh', '--pi-sidebar-width': '280px' },
      }, React.createElement(Sidebar, {
        projects: [], temporarySessions: [], labels, collapsed, onToggleCollapse: toggle,
      }), React.createElement('section', { id: 'chat', style: { flex: 1 } },
        React.createElement(TopBar, { title: 'PI Desktop', labels, onExpandSidebar: collapsed ? toggle : undefined })));
    }
    createRoot(root).render(React.createElement(Shell));
  });

  const sidebar = page.locator('aside.pi-sidebar');
  const collapse = page.getByRole('button', { name: 'Collapse sidebar', exact: true });
  const expand = page.getByRole('button', { name: '展开侧边栏', exact: true });
  await collapse.waitFor();
  const chat = page.locator('#chat');
  const initialChat = await chat.boundingBox();
  const initialSidebar = await sidebar.boundingBox();
  assert(initialSidebar.width > 0 && await expand.count() === 0, '展开态应显示侧栏和单个折叠按钮');
  await collapse.click();
  await expand.waitFor();
  assert(await sidebar.count() === 0, '折叠后完整项目侧栏仍在页面上');
  const foldedChat = await chat.boundingBox();
  assert(Math.abs(foldedChat.width - initialChat.width - initialSidebar.width) <= 1, '聊天区应收回侧栏宽度');
  await expand.click();
  await collapse.waitFor();
  assert(await expand.count() === 0 && (await chat.boundingBox()).width === initialChat.width, '再次展开应恢复初始布局');
  console.log('SIDEBAR TOGGLE OK');
}
