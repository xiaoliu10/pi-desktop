// 审批卡（InlineApprovalCard）键盘焦点回归：↓/↑/Tab 在选项与自定义指引行之间移动 DOM 焦点
// （roving tabindex，全程无需鼠标）、自定义行直接打字、Shift+Enter 换行不提交、裸 Enter 恰好
// 提交一次（store.answerDialog → localPi.respond mock 计数）；footer 按钮焦点不被方向键抢占。
// Vite at :5175; playwright-cli -s approvalkeys open about:blank; run-code --filename tests/approval-card-keys.browser.cjs
async (page) => {
  const assert = (ok, label) => { if (!ok) throw new Error(label); };
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.setViewportSize({ width: 900, height: 760 });
  await page.route('http://127.0.0.1:5175/approval-keys', route => route.fulfill({ contentType: 'text/html', body: '<html><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script></body></html>' }));
  await page.goto('http://127.0.0.1:5175/approval-keys');
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"]*)"/)[1])).default;
    const { InlineApprovalCard } = await import('/pi/PiReplicaApp.tsx');
    await import('/replica/tokens.css'); await import('/pi/replica-app.css');
    // answerDialog 按 request.id 在 store.dialogs 里定位后转发 respond。mock 直接挂到
    // usePiStore（组件从 hooks 捕获的同一个函数），重复 dispatch 必然累计为多次。
    const { usePiStore } = await import('/pi/adapter.ts');
    window.__respond = { calls: 0, values: [] };
    window.localPi = { stop: async () => ({ steering: [], followUp: [] }), respond: (key, gen, response) => { window.__respond.calls += 1; window.__respond.values.push(response); } };
    const title = ['Desktop 审批 · write', '[pi-desktop-meta]' + JSON.stringify({ name: 'parity-audit.md', dir: 'docs', add: 119, del: 4, cmd: '' }), '[pi-desktop-message]需要写入文件'].join('\n');
    const dialog = { key: 'k1', generation: 'g1', request: { id: 'r1', method: 'confirm', title, message: '写入 docs/parity-audit.md' } };
    usePiStore.setState({
      answerDialog: (response) => { window.__respond.calls += 1; window.__respond.values.push(response); },
      dialogs: [dialog],
    });
    const root = createRoot(document.getElementById('root'));
    root.render(React.createElement('main', { className: 'pireplica', style: { display: 'flex', flexDirection: 'column', height: '100vh' } },
      React.createElement('div', { style: { flex: 1 } }),
      React.createElement(InlineApprovalCard, { dialog })));
  });
  await page.locator('.pi-approval-inline').waitFor();
  await page.waitForTimeout(120);
  assert(await page.evaluate(() => document.activeElement?.classList?.contains('pi-approval-inline')), 'approval card container should auto-focus on mount');
  assert(await page.evaluate(() => Boolean(document.querySelector('[data-card-options].pi-eli__options'))), 'options row group carries data-card-options for the focus guard');

  // choice 初始 0：「允许」aria-checked，其余未选
  let sel = await page.evaluate(() => [...document.querySelectorAll('.pi-eli__options [role="radio"]')].map(b => b.getAttribute('aria-checked')));
  assert(sel[0] === 'true' && sel.slice(1).every(v => v === 'false'), `initial choice is 允许: ${JSON.stringify(sel)}`);

  // ↓ 一次：焦点+选中移到「始终允许本项目」（choice 1）
  await page.keyboard.press('ArrowDown');
  let focusInfo = await page.evaluate(() => ({ cls: document.activeElement?.className, text: document.activeElement?.textContent, checked: document.activeElement?.getAttribute('aria-checked') }));
  assert(focusInfo.cls?.includes('pi-eli__opt') && focusInfo.checked === 'true' && focusInfo.text?.includes('始终允许本项目'), `first ↓ focuses+checks option 2, got ${JSON.stringify(focusInfo)}`);

  // 再 ↓↓↓：焦点落到自定义指引 textarea（choice 4），高亮同步
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  assert(await page.evaluate(() => document.activeElement?.classList?.contains('pi-eli__input')), 'three more ↓ move DOM focus to custom textarea without any mouse click');
  assert(await page.evaluate(() => document.querySelector('.pi-eli__opt--custom')?.classList?.contains('pi-eli__opt--on')), 'custom row is highlighted at choice 4');

  // 焦点已在 textarea：直接打字进自定义指引
  await page.keyboard.type('按键盘直达的指引');
  const typed = await page.evaluate(() => document.querySelector('.pi-eli__input')?.value);
  assert(typed === '按键盘直达的指引', `typing lands in focused textarea, got ${JSON.stringify(typed)}`);

  // Shift+Enter 换行：插入 \n 且绝不提交；底部提示写明「Shift+Enter 换行」
  await page.keyboard.press('Shift+Enter');
  const afterShift = await page.evaluate(() => ({ value: document.querySelector('.pi-eli__input')?.value, calls: window.__respond.calls, note: document.querySelector('.pi-eli__note')?.textContent }));
  assert(afterShift.value === '按键盘直达的指引\n', `Shift+Enter inserts newline, got ${JSON.stringify(afterShift.value)}`);
  assert(afterShift.calls === 0, `Shift+Enter must not submit, got ${afterShift.calls} calls`);
  assert(afterShift.note?.includes('Shift+Enter 换行'), `foot note documents Shift+Enter, got ${afterShift.note}`);

  // ↑ 从自定义行移回上一选项「拒绝」，aria-checked 同步（choice 3）
  await page.keyboard.press('ArrowUp');
  focusInfo = await page.evaluate(() => ({ cls: document.activeElement?.className, text: document.activeElement?.textContent, checked: document.activeElement?.getAttribute('aria-checked') }));
  assert(focusInfo.cls?.includes('pi-eli__opt') && focusInfo.checked === 'true' && focusInfo.text?.includes('拒绝'), `ArrowUp from textarea refocuses 拒绝, got ${JSON.stringify(focusInfo)}`);

  // Tab 双向：↓ 回自定义行、Shift+Tab 再回「拒绝」、Tab 又回自定义行（选项 tabIndex=-1，全靠手动 focus）
  await page.keyboard.press('ArrowDown');
  assert(await page.evaluate(() => document.activeElement?.classList?.contains('pi-eli__input')), 'ArrowDown returns focus to textarea');
  await page.keyboard.press('Shift+Tab');
  focusInfo = await page.evaluate(() => ({ cls: document.activeElement?.className, text: document.activeElement?.textContent }));
  assert(focusInfo.cls?.includes('pi-eli__opt') && focusInfo.text?.includes('拒绝'), `Shift+Tab moves back to 拒绝, got ${JSON.stringify(focusInfo)}`);
  await page.keyboard.press('Tab');
  assert(await page.evaluate(() => document.activeElement?.classList?.contains('pi-eli__input')), 'Tab moves forward to textarea');

  // 焦点 guard：焦点在 footer 按钮时方向键不得抢占（焦点不动、选择不变、不触发提交）
  await page.click('.pi-btn--danger');
  assert(await page.evaluate(() => document.activeElement?.classList?.contains('pi-btn--danger')), 'click focuses the stop button');
  await page.keyboard.press('ArrowDown');
  focusInfo = await page.evaluate(() => ({
    stillStop: document.activeElement?.classList?.contains('pi-btn--danger'),
    customOn: document.querySelector('.pi-eli__opt--custom')?.classList?.contains('pi-eli__opt--on'),
    calls: window.__respond.calls,
  }));
  assert(focusInfo.stillStop && focusInfo.customOn && focusInfo.calls === 0, `ArrowDown must not steal focus/selection from footer button, got ${JSON.stringify(focusInfo)}`);

  // 裸 Enter 在自定义行 = 提交：恰好一次，值为去掉尾换行的指引文本
  await page.click('.pi-eli__input');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(120);
  const respond = await page.evaluate(() => window.__respond);
  assert(respond.calls === 1, `bare Enter must submit exactly once, got ${respond.calls} calls`);
  assert(respond.values?.[0]?.id === 'r1' && respond.values?.[0]?.value === '按键盘直达的指引', `submit carries trimmed custom text: ${JSON.stringify(respond.values)}`);

  await page.screenshot({ path: 'output/playwright/approval-card-keys.png' });
  assert(errors.length === 0, 'no page errors: ' + errors.join(' | '));
  return 'PASS approval-card-keys: container autofocus / ↓ follows highlight to textarea / type + Shift+Enter newline no submit / ↑·Tab·Shift+Tab back to options / footer focus guard / bare Enter submits exactly once';
}
