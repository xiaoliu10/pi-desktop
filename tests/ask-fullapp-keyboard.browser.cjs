// 完整 PiReplicaApp 环境下的 ask_user_question 键盘复现：
// 真实结构（全 app + 运行中 run + 流式事件持续到来）里注入 desktop-ask 对话框。
// 两轮独立挂载：
//   ① 鼠标点击轮：单击选项必须立刻出现选中描边（回归：--on 只有 6% 灰底，"点了没反应"）。
//   ② 键盘轮：不点击任何东西直接 ↓↓Enter（全 app 焦点环境），并断言活动项描边计算样式。
// 与 ask-keyboard.browser.cjs（孤立单卡）的差异是全 app 焦点环境。
// Vite at :5175; open: playwright-cli -s askfull2 open http://127.0.0.1:5175/ask-full && playwright-cli -s askfull2 run-code --filename tests/ask-fullapp-keyboard.browser.cjs
async (page) => {
  const assert = (ok, label) => { if (!ok) throw Error(label); };
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.route('http://127.0.0.1:5175/ask-full', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script>' }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('http://127.0.0.1:5175/ask-full');
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);

  // 挂载完整 app 并注入 desktop-ask 对话框（id 参数区分两轮）
  const boot = (id) => page.evaluate(async (rid) => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    await import('/styles.css'); await import('/replica/tokens.css');
    const { default: App, usePiStore } = await import('/pi/PiReplicaApp.tsx');
    window.store = usePiStore;
    window.run = { key: 'k1', generation: 'g1', cwd: '/synthetic', status: 'running', models: [], commands: [], pending: 0 };
    window.respondLog = [];
    window.localPi = {
      settingsSnapshot: async () => ({ preferences: { behavior: 'followUp', permission: 'fullAccess', shortcuts: {}, projects: [] }, ai: {}, resources: [], mcp: [], mcpRevisions: {}, diagnostics: [], projects: [], loadedExtensions: [] }),
      environment: async () => ({ supported: true, version: '0.99.1' }),
      sessions: async () => [], runs: async () => [window.run], archivedSessions: async () => [],
      onEvent: fn => { window.emit = fn; }, history: async () => ({ branch: [] }),
      prompt: async () => ({}), stop: async () => {},
      respond: (key, gen, response) => { window.respondLog.push(response); },
      listFiles: async () => [], externalApps: async () => [], projectBranch: async () => null,
      gitStatus: async () => ({ isRepo: false, files: [] }),
    };
    usePiStore.getState().init();
    await new Promise(resolve => setTimeout(resolve, 0));
    const askRequest = {
      id: 'r-ask-' + rid, method: 'input', title: 'desktop-ask',
      placeholder: JSON.stringify({ questions: [
        { header: '实现方案', question: '采用哪种持久化方式？', options: [{ label: 'SQLite', description: '单文件' }, { label: 'JSON 文件', description: '便于手工编辑' }, { label: 'Postgres', description: '服务器' }] },
      ] }),
    };
    usePiStore.setState({
      ready: true, selectedKey: 'k1', runs: [window.run], history: { branch: [] }, sends: [], live: {}, toolProgress: {},
      view: 'chat', lang: 'zh', workbenchOpen: false,
      dialogs: [{ key: 'k1', generation: 'g1', request: askRequest }],
    });
    window.rpc = event => window.emit({ type: 'rpc', key: 'k1', generation: 'g1', event });
    createRoot(document.getElementById('root')).render(React.createElement(App));
  }, id);

  // ─── ① 鼠标点击轮：单击选项必须立刻出现可见选中态 ───
  await boot('click');
  await page.locator('.pi-eli').waitFor({ timeout: 8000 });
  await page.waitForTimeout(250);
  await page.locator('.pi-eli__opt', { hasText: 'JSON 文件' }).click();
  await page.waitForTimeout(120);
  const clicked = await page.evaluate(() => {
    const el = [...document.querySelectorAll('.pi-eli__opt')].find(n => n.textContent.includes('JSON 文件'));
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { on: el.className.includes('pi-eli__opt--on'), outline: cs.outlineStyle + ' ' + cs.outlineWidth };
  });
  assert(clicked && clicked.on, `单击后应有 --on 选中态，got: ${JSON.stringify(clicked)}`);
  assert(clicked.outline.includes('solid'), `单击选中项应有主色描边（6% 灰底无法感知），got: ${JSON.stringify(clicked)}`);
  await page.screenshot({ path: 'output/playwright/ask-click-selected.png', clip: { x: 200, y: 300, width: 1040, height: 520 } });

  // ─── ② 键盘轮：刷新后全新挂载，不点击直接 ↓↓Enter ───
  await page.reload();
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await boot('kbd');
  await page.locator('.pi-eli').waitFor({ timeout: 8000 });
  await page.waitForTimeout(250);

  // 挂载后不点击：焦点应该已在卡片容器里
  const focus = await page.evaluate(() => ({
    isEli: !!document.activeElement?.classList?.contains('pi-eli'),
    active: (document.activeElement?.className || document.activeElement?.tagName || '').toString().slice(0, 60),
  }));

  // 模拟真实场景：流式 delta 持续到来（每秒多次 re-render）后再按键
  await page.evaluate(() => {
    window.rpc({ type: 'message_start', message: { role: 'assistant', timestamp: 901, content: [] } });
    window.rpc({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'streaming...' } });
  });
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(100);
  const after1 = await page.evaluate(() => document.querySelector('.pi-eli__opt--active')?.textContent || 'NONE');
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(100);
  const after2 = await page.evaluate(() => document.querySelector('.pi-eli__opt--active')?.textContent || 'NONE');
  // 键盘高亮的视觉强度：活动项应有主色描边（回归：4% 透明度灰不可见的问题）。
  // 注意必须在 Enter 之前查——Enter 提交后卡片即卸载。
  const activeStyle = await page.evaluate(() => {
    const el = document.querySelector('.pi-eli__opt--active');
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { outline: cs.outlineStyle + ' ' + cs.outlineWidth + ' ' + cs.outlineColor, bg: cs.backgroundColor };
  });
  await page.screenshot({ path: 'output/playwright/ask-keyboard-active.png', clip: { x: 200, y: 300, width: 1040, height: 520 } });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  const responded = await page.evaluate(() => window.respondLog);

  const result = { focus, after1, after2, responded, errors };
  await page.evaluate(r => { document.title = 'RESULT ' + JSON.stringify(r); }, result);
  assert(focus.isEli, `挂载后焦点应在卡片容器（pi-eli），got: ${focus.active}`);
  assert(after1.includes('SQLite'), `第一次 ↓ 应高亮第一项，got: ${after1}`);
  assert(after2.includes('JSON 文件'), `第二次 ↓ 应高亮第二项，got: ${after2}`);
  assert(JSON.stringify(responded).includes('JSON 文件'), `Enter 应提交第二项，got ${JSON.stringify(responded)}`);
  assert(activeStyle && activeStyle.outline.includes('solid'), `活动项应有主色描边，got: ${JSON.stringify(activeStyle)}`);
  assert(!errors.length, `页面错误: ${errors.join('; ')}`);
}
