// ZCode 式 workbench 首页（功能选择卡片）+ 辅助对话 tab 交互。
// Vite at :5175 (bind 127.0.0.1): npx vite --port 5175 --host 127.0.0.1
// playwright-cli -s workbench open about:blank; run-code --filename tests/workbench-home.browser.cjs
async (page) => {
  const assert = (ok, label) => { if (!ok) throw new Error(label); };
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.setViewportSize({ width: 1200, height: 850 });
  await page.route('http://127.0.0.1:5175/workbench-home', route => route.fulfill({ contentType: 'text/html', body: '<html><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script></body></html>' }));
  await page.goto('http://127.0.0.1:5175/workbench-home');
  await page.evaluate(() => localStorage.removeItem('pi.sidecarDraft:main-1')); // 跨桩残留会污染辅助对话草稿初始值
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    const { WorkbenchPanel } = await import('/replica/workbench/WorkbenchPanel.tsx');
    const { SidecarPanel } = await import('/pi/SidecarPanel.tsx');
    // 辅助对话插槽渲染真实 SidecarPanel（review P3-5：keep-alive 锁组件语义——草稿跨 tab 保留）
    window.localPi = {
      sidecarBinding: async () => 'k1',
      sidecarEnsure: async () => ({ key: 'k1', run: { key: 'k1', generation: 'g', cwd: '/w', file: '/w/s.jsonl', status: 'idle', accessMode: 'ask', models: [], commands: [], pending: 0 } }),
      history: async () => ({ session: {}, entries: [], branch: [], leaves: [], leafId: null, syncedAt: 1 }),
      onEvent: () => () => {}, prompt: async () => ({}), stop: async () => ({ steering: [], followUp: [] }), respond: async () => ({}),
    };
    const labels = {
      review: '变更', files: '文件', browser: '浏览器', auxiliary: '辅助对话',
      homeTitle: '要打开哪个功能？', homeReview: '查看本次会话的文件改动。', homeFiles: '浏览已打开项目的文件。',
      homeBrowser: '在面板内浏览网页。', homeAuxiliary: '为当前会话开一个只读旁路对话。',
      close: '关闭面板', emptyReview: '还没有变更', emptyReviewHint: '改动会显示在这里。',
      emptyFiles: '打开项目后可浏览文件', emptyFilesHint: '只能浏览已打开的项目。',
      emptyBrowser: '浏览器预览不可用', emptyBrowserHint: '第一阶段不加载外部页面。',
      created: '新文件', selectFile: '选择文件…',
    };
    function Fixture() {
      const [tab, setTabState] = React.useState('home');
      window.__setTab = setTabState;
      const picks = [];
      window.picks = picks;
      return React.createElement('main', { style: { display: 'flex', minHeight: '100vh' } }, React.createElement(WorkbenchPanel, {
        open: true, tab, diffs: [], files: [], selectedFile: null, demo: false, labels,
        sidecarPanel: React.createElement(SidecarPanel, { mainKey: 'main-1', autoStart: false, onClose() {} }),
        onToggle() {}, onSelectTab(t) { picks.push(t); window.__setTab(t); }, onSelectFile() {},
      }));
    }
    createRoot(document.getElementById('root')).render(React.createElement(Fixture));
  });
  const panel = page.locator('.pi-workbench');
  await panel.locator('.pi-workbench__home').waitFor({ timeout: 5000 });
  assert(await panel.locator('.pi-workbench__homecard').count() === 4, 'home shows four function cards');
  assert(await panel.locator('.pi-workbench__tab').count() === 4, 'header has four tabs including auxiliary chat');
  assert(await panel.getByText('要打开哪个功能？').count() === 1, 'home title shows');
  // 点「辅助对话」卡片 → aux tab → keep-alive 插槽显示
  await panel.locator('.pi-workbench__homecard', { hasText: '辅助对话' }).click();
  await panel.locator('.pi-workbench__auxslot textarea').waitFor({ timeout: 5000 });
  assert(await panel.locator('.pi-workbench__tab--on', { hasText: '辅助对话' }).count() === 1, 'aux tab becomes active');
  // 切到「文件」→ 辅助对话插槽 keep-alive（display:none 但仍在 DOM）
  await panel.locator('.pi-workbench__tab', { hasText: '文件' }).click();
  await page.waitForFunction(() => {
    const slot = document.querySelector('.pi-workbench__auxslot');
    return slot && slot.style.display === 'none' && slot.querySelector('textarea');
  }, undefined, { timeout: 5000 });
  assert(await panel.locator('.pi-workbench__auxslot').count() === 1, 'aux slot stays mounted (keep-alive) on other tabs');
  // 回到 home：body 隐藏、卡片可见
  await page.evaluate(() => window.__setTab('home'));
  await panel.locator('.pi-workbench__home').waitFor({ timeout: 5000 });
  assert(await panel.locator('.pi-workbench__homecard').count() === 4, 'returning home shows the picker again');
  // keep-alive 的组件语义（review P3-5）：真实 SidecarPanel 在切 tab 后本地 state（草稿）保留
  await page.evaluate(() => window.__setTab('aux'));
  await panel.locator('.pi-workbench__auxslot textarea').waitFor({ timeout: 5000 });
  await panel.locator('.pi-workbench__auxslot textarea').fill('keep-alive 草稿');
  await page.evaluate(() => window.__setTab('review'));
  await page.waitForTimeout(120);
  await page.evaluate(() => window.__setTab('aux'));
  await page.waitForFunction(() => document.querySelector('.pi-workbench__auxslot textarea')?.value === 'keep-alive 草稿', undefined, { timeout: 5000 });
  assert(errors.length === 0, 'no page errors: ' + errors.join(' | '));
  await page.locator('.pi-workbench').screenshot({ path: 'output/playwright/workbench-home.png' });
  return 'PASS workbench-home: 4 cards picker, aux tab switches, keep-alive slot survives tab switches';
}
