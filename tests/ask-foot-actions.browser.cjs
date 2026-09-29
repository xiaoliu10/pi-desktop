// qoderwaker 风格操作条回归：左危险红字（停止任务）、中间提示占满省略、右侧等高主次按钮、文字不换行。
// 覆盖 AskQuestionCard foot / InlineApprovalCard foot / ExtensionDialog actions，亮暗两主题截图。
// Vite at :5175; playwright-cli -s askfoot open about:blank; run-code --filename tests/ask-foot-actions.browser.cjs
async (page) => {
  const assert = (ok, label) => { if (!ok) throw new Error(label); };
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.setViewportSize({ width: 900, height: 760 });
  await page.route('http://127.0.0.1:5175/ask-foot', route => route.fulfill({ contentType: 'text/html', body: '<html><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script></body></html>' }));
  await page.goto('http://127.0.0.1:5175/ask-foot');
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    const { AskQuestionCard, InlineApprovalCard, ExtensionDialog, parseAskPayload } = await import('/pi/PiReplicaApp.tsx');
    await import('/replica/tokens.css'); await import('/pi/replica-app.css');
    window.localPi = { stop: async () => {}, answerDialog: async () => true };
    window.React = React; window.createRoot = createRoot;
    window.renderAsk = (dark) => {
      const payload = parseAskPayload(JSON.stringify({ questions: [
        { header: '目标', question: '选择一个方向？', options: [{ label: '方案 A', description: '先做 A' }, { label: '方案 B', description: '先做 B' }] },
      ] }));
      const root = createRoot(document.getElementById('root'));
      root.render(React.createElement('main', { className: `pireplica${dark ? ' pireplica--dark' : ''}`, style: { padding: 24 } },
        React.createElement('section', { className: 'pi-ask-inline' },
          React.createElement(AskQuestionCard, {
            payload, zh: true,
            onAnswer: () => {}, onCancel: () => {}, stopTask: () => {}, stopping: false,
          }))));
    };
    window.renderApproval = (dark) => {
      const title = ['Desktop 审批 · write', '[pi-desktop-meta]' + JSON.stringify({ name: 'parity-audit.md', dir: 'docs', add: 119, del: 4, cmd: '' }), '[pi-desktop-message]需要写入文件'].join('\n');
      const request = { id: 'r1', method: 'confirm', title, message: '写入 docs/parity-audit.md' };
      const root = createRoot(document.getElementById('root'));
      root.render(React.createElement('main', { className: `pireplica${dark ? ' pireplica--dark' : ''}`, style: { display: 'flex', flexDirection: 'column', height: '100vh' } },
        React.createElement('div', { style: { flex: 1 } }),
        React.createElement(InlineApprovalCard, { dialog: { key: 'k1', generation: 'g1', request } })));
    };
    window.renderModal = (dark) => {
      const request = { id: 'r2', method: 'confirm', title: 'pi extension', message: '允许执行该操作？' };
      const root = createRoot(document.getElementById('root'));
      root.render(React.createElement('main', { className: `pireplica${dark ? ' pireplica--dark' : ''}`, style: { padding: 24 } },
        React.createElement(ExtensionDialog, { dialog: { key: 'k1', generation: 'g1', request } })));
    };
  });

  const footChecks = () => {
    const foot = document.querySelector('.pi-eli__foot');
    const kids = [...foot.children];
    const danger = foot.querySelector('.pi-btn--danger');
    const primary = foot.querySelector('.pi-btn--primary');
    const outline = foot.querySelector('.pi-btn--outline');
    const note = foot.querySelector('.pi-eli__note');
    const stopText = danger?.textContent ?? '';
    const heights = [...foot.querySelectorAll('.pi-btn')].map(b => Math.round(b.getBoundingClientRect().height));
    const dangerRect = danger?.getBoundingClientRect();
    const noteRect = note?.getBoundingClientRect();
    const actionsRect = foot.querySelector('.pi-eli__actions')?.getBoundingClientRect();
    const dangerColor = danger ? getComputedStyle(danger).color : '';
    const dangerBorder = danger ? getComputedStyle(danger).borderTopColor : '';
    return {
      orderOk: kids[0] === danger,
      stopText,
      dangerColor, dangerBorder,
      dangerTransparentBg: danger ? getComputedStyle(danger).backgroundColor === 'rgba(0, 0, 0, 0)' : false,
      heightsUniform: new Set(heights).size === 1,
      dangerLeftOfNote: dangerRect && noteRect ? dangerRect.right <= noteRect.left : false,
      noteFlex: note ? getComputedStyle(note).flexGrow === '1' : false,
      actionsRightOfNote: noteRect && actionsRect ? actionsRect.left >= noteRect.right : false,
      primaryPresent: Boolean(primary), outlinePresent: Boolean(outline),
      noWrap: [...foot.querySelectorAll('.pi-btn')].every(b => getComputedStyle(b).whiteSpace === 'nowrap'),
    };
  };

  // ---- Case 1: ask 卡 foot（亮色）----
  await page.evaluate(() => window.renderAsk(false));
  await page.locator('.pi-eli__foot').waitFor();
  let c = await page.evaluate(footChecks);
  assert(c.orderOk && c.dangerLeftOfNote && c.actionsRightOfNote, `ask foot order must be danger|note|actions: ${JSON.stringify(c)}`);
  assert(c.stopText.includes('停止任务'), `danger label: ${c.stopText}`);
  assert(c.heightsUniform, `ask foot buttons equal height: ${JSON.stringify(c.heightsUniform)}`);
  assert(c.noteFlex && c.noWrap, `note flex + nowrap: ${JSON.stringify(c)}`);
  assert(c.dangerTransparentBg, 'danger has transparent bg');
  await page.screenshot({ path: 'output/playwright/ask-foot-actions-light.png' });

  // ---- Case 2: ask 卡 foot（暗色）----
  await page.evaluate(() => window.renderAsk(true));
  await page.locator('.pi-eli__foot').waitFor();
  c = await page.evaluate(footChecks);
  assert(c.orderOk && c.heightsUniform, `ask foot dark: ${JSON.stringify(c)}`);
  assert(c.dangerTransparentBg, 'danger dark transparent bg');
  await page.screenshot({ path: 'output/playwright/ask-foot-actions-dark.png' });

  // ---- Case 3: 审批卡 foot（亮色）：danger 左、确认右、等高 ----
  await page.evaluate(() => window.renderApproval(false));
  await page.locator('.pi-approval-inline').waitFor();
  c = await page.evaluate(footChecks);
  assert(c.orderOk && c.stopText.includes('停止任务'), `approval foot order: ${JSON.stringify(c)}`);
  assert(c.heightsUniform && c.primaryPresent && !c.outlinePresent, `approval foot buttons: ${JSON.stringify(c)}`);
  await page.screenshot({ path: 'output/playwright/approval-foot-actions-light.png' });

  // ---- Case 4: ExtensionDialog footer：danger 最左，actions-main 在右（outline+primary），34px 等高 ----
  await page.evaluate(() => window.renderModal(false));
  await page.locator('.pi-connectmodal__actions').waitFor();
  const modal = await page.evaluate(() => {
    const foot = document.querySelector('.pi-connectmodal__actions');
    const danger = foot.querySelector(':scope > .pi-btn--danger');
    const main = foot.querySelector('.pi-connectmodal__actions-main');
    const mainBtns = main ? [...main.querySelectorAll('.pi-btn')] : [];
    const heights = [...foot.querySelectorAll('.pi-btn')].map(b => Math.round(b.getBoundingClientRect().height));
    const dRect = danger?.getBoundingClientRect();
    const mRect = main?.getBoundingClientRect();
    return {
      dangerFirst: foot.firstElementChild === danger,
      mainLast: foot.lastElementChild === main,
      mainHasOutlinePrimary: mainBtns.length === 2 && mainBtns[0].classList.contains('pi-btn--outline') && mainBtns[1].classList.contains('pi-btn--primary'),
      heightsUniform: new Set(heights).size === 1,
      dangerLeft: dRect && mRect ? dRect.right <= mRect.left : false,
      stopText: danger?.textContent ?? '',
    };
  });
  assert(modal.dangerFirst && modal.mainLast && modal.mainHasOutlinePrimary, `modal actions structure: ${JSON.stringify(modal)}`);
  assert(modal.heightsUniform && modal.dangerLeft, `modal actions layout: ${JSON.stringify(modal)}`);
  await page.screenshot({ path: 'output/playwright/modal-foot-actions-light.png' });

  assert(errors.length === 0, `page errors: ${errors.join('; ')}`);
  console.log('ask-foot-actions: all checks passed');
}
