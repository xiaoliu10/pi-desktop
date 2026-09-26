// Verify approval interactions never push action buttons off-screen.
// 命令权限审批 → ZCode 五选项内联卡（工具行+允许/始终允许/完全访问/拒绝/自定义指引+确认）；
// 计划审批 → 右侧计划面板展示全文（tests/plan-approval-sidepanel.browser.cjs）。
// Vite at :5175; open a session first: playwright-cli -s mx open about:blank
// then: playwright-cli -s mx run-code --filename tests/extension-dialog-overflow.browser.cjs
async (page) => {
  const assert = (ok, label) => { if (!ok) throw new Error(label); };
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.route('http://127.0.0.1:5175/dlg-test', route => route.fulfill({ contentType: 'text/html', body: '<html><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script></body></html>' }));
  await page.setViewportSize({ width: 1100, height: 720 });
  await page.goto('http://127.0.0.1:5175/dlg-test');
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    const { ExtensionDialog, InlineApprovalCard } = await import('/pi/PiReplicaApp.tsx');
    const { usePiStore } = await import('/pi/adapter.ts');
    await import('/replica/tokens.css'); await import('/pi/replica-app.css'); await import('/replica/overlays/overlays.css');
    window.localPi = { stop: async () => {}, respond: async (key, gen, response) => { window.__answers.push(response); }, answerDialog: async () => true };
    window.__answers = [];
    window.seedDialog = (request) => usePiStore.setState({ dialogs: [{ key: 'k1', generation: 'g1', request }] });
    const root = createRoot(document.getElementById('root'));
    window.encodeApproval = (msg) => ['Desktop 审批 · write', '[pi-desktop-meta]' + JSON.stringify({ name: 'parity-audit.md', dir: 'docs', add: 119, del: 4, cmd: '' }), '[pi-desktop-message]' + msg].join('\n');
    window.renderInlineApproval = (request) => {
      root.render(React.createElement('main', { className: 'pireplica', style: { display: 'flex', flexDirection: 'column', height: '100vh' } },
        React.createElement('div', { style: { flex: 1 } }),
        React.createElement(InlineApprovalCard, { key: `${request.id}`, dialog: { key: 'k1', generation: 'g1', request } })));
    };
    window.renderDlg = (request) => {
      root.render(React.createElement('main', { className: 'pireplica' },
        React.createElement(ExtensionDialog, { dialog: { key: 'k1', generation: 'g1', request } })));
    };
    window.measure = () => {
      const card = document.querySelector('.pi-approval-inline');
      const cb = card.getBoundingClientRect();
      const options = [...card.querySelectorAll('.pi-eli__opt')];
      return {
        vh: innerHeight,
        cardTop: Math.round(cb.top), cardBottom: Math.round(cb.bottom),
        cardFitsViewport: cb.bottom <= innerHeight + 0.5 && cb.top >= 0,
        optionCount: options.length,
        optionsInViewport: options.every(b => { const r = b.getBoundingClientRect(); return r.bottom <= innerHeight && r.top >= 0; }),
        overlayPresent: Boolean(document.querySelector('.pi-overlay')),
        drawerPresent: Boolean(document.querySelector('.pi-approval-drawer')),
      };
    };
  });

  const meta = { name: 'parity-audit.md', dir: 'docs', add: 119, del: 4, cmd: '' };
  const encoded = (msg) => ['Desktop 审批 · write', '[pi-desktop-meta]' + JSON.stringify(meta), '[pi-desktop-message]' + msg].join('\n');

  // Case 1: select with many options -> centered modal, constrained + footer reachable
  await page.evaluate(() => window.renderDlg({ id: 'r1', method: 'select', title: 'pi extension', options: Array.from({ length: 30 }, (_, i) => `选项 ${i + 1} — 一段比较长的选项描述用来占高度`) }));
  await page.locator('.pi-connectmodal').waitFor();
  const m1 = await page.evaluate(() => ({ modal: Boolean(document.querySelector('.pi-connectmodal')), footerVisible: (() => { const f = document.querySelector('.pi-connectmodal__actions'); const r = f.getBoundingClientRect(); return r.bottom <= innerHeight && r.top >= 0; })() }));
  assert(m1.modal && m1.footerVisible, `select modal must fit viewport: ${JSON.stringify(m1)}`);
  await page.screenshot({ path: 'output/playwright/modal-overflow-select-after.png' });

  // Case 2: command approval -> ZCode 五选项内联卡，工具行 + 选项可见
  await page.evaluate(() => window.renderInlineApproval({ id: 'r2', method: 'select', title: window.encodeApproval('工作目录：/mock\n变更预览：\n+ line 1\n'.repeat(200)), options: [] }));
  await page.locator('.pi-approval-inline').waitFor();
  const m = await page.evaluate(() => window.measure());
  assert(m.cardFitsViewport, `inline approval card must fit viewport: ${JSON.stringify(m)}`);
  assert(m.optionCount === 5, `five option rows expected, got ${m.optionCount}`);
  assert(m.optionsInViewport, `all options must be visible: ${JSON.stringify(m)}`);
  assert(!m.overlayPresent && !m.drawerPresent, 'inline approval must not use overlay or drawer');
  // 工具行元数据
  const toolRow = await page.locator('.pi-approval-inline__tool').innerText();
  assert(toolRow.includes('parity-audit.md') && toolRow.includes('docs') && toolRow.includes('+119') && toolRow.includes('−4'), `tool row shows meta, got ${toolRow}`);
  // 展开 › 显示 diff 文档（限高滚动区）
  await page.click('.pi-approval-inline__tool');
  const doc = page.locator('.pi-approval-inline__doc');
  await doc.waitFor();
  assert(await doc.evaluate(el => el.scrollHeight > el.clientHeight), 'doc region should scroll internally');
  await page.screenshot({ path: 'output/playwright/approval-inline-after.png' });

  // Case 3: 选「拒绝」→ respond value='拒绝'
  await page.evaluate(() => window.seedDialog({ id: 'r2', method: 'select', title: window.encodeApproval('') }));
  await page.locator('.pi-approval-inline .pi-eli__opt').nth(3).click();
  await page.locator('.pi-approval-inline .pi-btn--primary').click();
  await page.waitForTimeout(50);
  let answers = await page.evaluate(() => window.__answers);
  assert(answers.length === 1 && answers[0].value === '拒绝', `deny option should respond 拒绝, got ${JSON.stringify(answers)}`);

  // Case 4: 自定义指引文字 → respond value=文字（重渲染新卡片，store 同步种入同 id dialog）
  await page.evaluate(() => { window.__answers = []; window.renderInlineApproval({ id: 'r3', method: 'select', title: window.encodeApproval('') }); window.seedDialog({ id: 'r3', method: 'select', title: window.encodeApproval('') }); });
  await page.locator('.pi-approval-inline').waitFor();
  await page.click('.pi-eli__input');
  await page.keyboard.type('改用增量写入，别全量覆盖');
  await page.keyboard.press('Enter'); // 自定义行 Enter 确认
  await page.waitForTimeout(50);
  answers = await page.evaluate(() => window.__answers);
  assert(answers.length === 1 && answers[0].value === '改用增量写入，别全量覆盖', `custom guidance should respond text, got ${JSON.stringify(answers)}`);

  // Case 5: 默认「允许」+ Enter 确认
  await page.evaluate(() => { window.__answers = []; window.renderInlineApproval({ id: 'r4', method: 'select', title: window.encodeApproval('') }); window.seedDialog({ id: 'r4', method: 'select', title: window.encodeApproval('') }); });
  await page.locator('.pi-approval-inline').waitFor();
  await page.locator('.pi-approval-inline').focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(50);
  answers = await page.evaluate(() => window.__answers);
  assert(answers.length === 1 && answers[0].value === '允许', `default allow + Enter should respond 允许, got ${JSON.stringify(answers)}`);

  assert(errors.length === 0, 'no page errors: ' + errors.join(' | '));
  return 'PASS extension-dialog-overflow: select modal constrained; approval is a ZCode 5-option inline card (tool row meta + doc scroll + deny/custom/allow responses)';
}
