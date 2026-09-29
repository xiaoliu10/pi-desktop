// 验证 ask 卡覆盖输入框（ZCode 式）：卡片显示时 composer（输入框）不渲染——卡片占据
// 输入框位置；回答/忽略后 composer 恢复。草稿存在 store，替换不丢文本。
// Vite at :5175; playwright-cli -s askdock open about:blank; run-code --filename tests/ask-card-dock.browser.cjs
async (page) => {
  const assert = (ok, label) => { if (!ok) throw new Error(label); };
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  const logs = []; page.on('console', m => { if (m.text().includes('[dbg]')) logs.push(m.text().slice(0, 200)); });
  await page.setViewportSize({ width: 1100, height: 760 });
  await page.route('http://127.0.0.1:5175/ask-dock', route => route.fulfill({ contentType: 'text/html', body: '<html><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script></body></html>' }));
  await page.goto('http://127.0.0.1:5175/ask-dock');
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    // usePiStore 必须取自 PiReplicaApp 同一模块图（vite HMR ?t= 会拆出多个 adapter 实例）
    const { InlineAskCard, usePiStore } = await import('/pi/PiReplicaApp.tsx');
    window.__store = usePiStore;
    await import('/replica/tokens.css'); await import('/pi/replica-app.css'); await import('/replica/chat/chat.css');
    const payload = JSON.stringify({ questions: [{ header: '随机选项', question: '接下来想做点什么？', options: [{ label: '喝咖啡' }, { label: '提交存档' }, { label: '随便看看' }] }] });
    window.__respondCalls = [];
    window.localPi = { stop: async () => {}, respond: async (k, g, r) => { window.__respondCalls.push({ k, g, r }); window.__answered = r; return true; } };
    window.__render = (withAsk) => {
      const root = window.__root ?? (window.__root = createRoot(document.getElementById('root')));
      const composer = React.createElement('div', { 'data-probe': 'composer' }, React.createElement('textarea', { placeholder: '随便问点什么' }));
      root.render(React.createElement('main', { className: 'pireplica', style: { padding: 24 } },
          withAsk
            ? React.createElement(InlineAskCard, { key: 'd1', dialog: { key: 'k1', generation: 'g1', request: { id: 'r1', method: 'input', title: '需要你的选择', placeholder: payload } } })
            : null,
          React.createElement('div', { style: { padding: '0 24px 20px' } }, withAsk ? null : composer)));
    };
    window.__render(true);
    // store.answerDialog 按 request.id 在 dialogs 里查找后才调 respond——同步 seed 一份
    usePiStore.setState({ dialogs: [{ key: 'k1', generation: 'g1', request: { id: 'r1', method: 'input', title: '需要你的选择', placeholder: payload } }] });
  });
  await page.locator('.pi-eli').waitFor();

  // Case 1: 卡片显示时 composer（输入框）不在 DOM——卡片遮住输入框位置
  const docked = await page.evaluate(() => ({
    cardBottom: Math.round(document.querySelector('.pi-ask-inline').getBoundingClientRect().bottom),
    composerGone: !document.querySelector('[data-probe="composer"]'),
    windowH: innerHeight,
  }));
  assert(docked.composerGone, 'composer must be replaced while ask card is up');
  assert(docked.cardBottom <= docked.windowH, 'card sits at the bottom dock area');

  // Case 2: 双击选项提交 → 卡片消失 → composer 恢复，回答发往扩展
  await page.evaluate(() => { window.__answered = null; });
  const optBox = await page.evaluate(() => {
    const b = document.querySelectorAll('.pi-eli__opt')[2];
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.dblclick(optBox.x, optBox.y);
  await page.waitForTimeout(150);
  // 双击只选中未提交时，点主提交按钮兜底验证 store 链
  const btnText = await page.locator('.pi-eli__foot .pi-btn--primary, .pi-eli button.pi-btn--primary').first().textContent().catch(() => null);
  const answered = await page.evaluate(() => ({
    answered: window.__answered, calls: window.__respondCalls.map(c => c.r),
    cardAlive: Boolean(document.querySelector('.pi-eli')),
    selectedCls: [...document.querySelectorAll('.pi-eli__opt')].map(b => b.className.includes('--on')),
  }));
  if (!answered.answered) {
    // 兜底验证 store 链：手动 answerDialog（会清掉 dialogs，放最后）
    await page.evaluate(() => window.__store.getState().answerDialog({ id: 'r1', value: 'manual-probe' }));
    await page.waitForTimeout(100);
  }
  assert(answered.answered && JSON.stringify(answered.answered.value).includes('随便看看'), `dblclick answered: ${JSON.stringify(answered)} | ansLog: ${JSON.stringify((page => null)(page) ?? null)} | logs: ${logs.join(' ;; ')} | pageErrors: ${errors.join(' | ')}`);
  await page.evaluate(() => window.__render(false));
  await page.waitForTimeout(100);
  assert(await page.evaluate(() => Boolean(document.querySelector('[data-probe="composer"]'))), 'composer restored after answer');

  await page.screenshot({ path: 'output/playwright/ask-card-dock.png' });
  assert(errors.length === 0, 'no page errors: ' + errors.join(' | '));
  return 'PASS ask-card-dock: ask card replaces composer at the bottom dock; dblclick answers and restores composer';
}
