// 回归：回合进行中（running=true 强制展开）点击 summary 不得折叠（此前点一下就收起，
// onToggle 被 !running 挡住导致 React 不知道，用户看到"过程块打不开"）；完成态组开合正常。
async (page) => {
  const assert = (ok, label) => { if (!ok) throw new Error(label); };
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.route('http://127.0.0.1:5175/dlg-test', route => route.fulfill({ contentType: 'text/html', body: '<html><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script></body></html>' }));
  await page.goto('http://127.0.0.1:5175/dlg-test');
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    const { ExecutionGroup } = await import('/replica/chat/ChatView.tsx');
    const labels = { you: '你' };
    const turn = { id: 'm1', role: 'assistant', startedAt: Date.now() - 1019 * 1000, steps: [
      { kind: 'tool', id: 't1', toolName: 'read', title: '读取 a.ts', status: 'done' },
      { kind: 'tool', id: 't2', toolName: 'bash', title: '运行测试', status: 'running' },
    ] };
    const root = createRoot(document.getElementById('root'));
    window.renderGroup = (running) => root.render(React.createElement(ExecutionGroup, { turn, parts: turn.steps, labels, running, active: running, expanded: running, showElapsed: true }));
    window.probe = () => { const d = document.querySelector('details.pi-execution'); return d ? d.open : null; };
    window.clickSummary = async () => { const r = document.querySelector('summary.pi-execution__summary').getBoundingClientRect(); await new Promise(done => setTimeout(done, 30)); return { x: r.left + 150, y: Math.max(10, r.top + r.height / 2) }; };
    window.renderGroup(true);
  });
  // Case 1: running 组初始展开；连续点击多次都保持展开（不折叠）
  assert(await page.evaluate(() => window.probe()) === true, 'live group starts expanded');
  for (let i = 0; i < 3; i++) {
    const p = await page.evaluate(() => window.clickSummary());
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(120);
    assert(await page.evaluate(() => window.probe()) === true, `live group stays expanded after click ${i + 1}`);
  }
  // Case 2: 完成态组：初始折叠，点击展开，再点收起
  await page.evaluate(() => window.renderGroup(false));
  await page.waitForTimeout(100);
  assert(await page.evaluate(() => window.probe()) === false, 'done group starts collapsed');
  const p = await page.evaluate(() => window.clickSummary());
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(120);
  assert(await page.evaluate(() => window.probe()) === true, 'done group expands on click');
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(120);
  assert(await page.evaluate(() => window.probe()) === false, 'done group collapses on second click');
  assert(errors.length === 0, 'no page errors: ' + errors.join(' | '));
  return 'PASS execution-group-toggle: live group ignores collapse clicks; done group toggles normally';
}
