// ask 卡双击交互（ZCode 同款）：双击选项 = 定为选中并立即推进/提交。
// 单选双击须绕过 click/dblclick 之间 toggle 的中间态（两次 click 会选中又取消）。
// Vite at :5175; playwright-cli -s askdbl open about:blank; run-code --filename tests/ask-card-doubleclick.browser.cjs
async (page) => {
  const assert = (ok, label) => { if (!ok) throw new Error(label); };
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.setViewportSize({ width: 900, height: 700 });
  await page.route('http://127.0.0.1:5175/ask-dbl', route => route.fulfill({ contentType: 'text/html', body: '<html><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script></body></html>' }));
  await page.goto('http://127.0.0.1:5175/ask-dbl');
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    const { AskQuestionCard, parseAskPayload } = await import('/pi/PiReplicaApp.tsx');
    await import('/replica/tokens.css'); await import('/replica/chat/chat.css'); await import('/pi/replica-app.css');
    window.localPi = { stop: async () => {}, answerDialog: async () => true };
    window.parseAskPayload = parseAskPayload;
    window.__mount = (payload, key) => {
      window.__result = { answers: null, cancelled: 0 };
      const root = window.__root ?? (window.__root = createRoot(document.getElementById('root')));
      root.render(React.createElement('main', { className: 'pireplica', style: { padding: 24 } },
        React.createElement('section', { className: 'pi-ask-inline' },
          React.createElement(AskQuestionCard, {
            key: key ?? 'k', payload, zh: true,
            onAnswer: (a) => { window.__result.answers = a; },
            onCancel: () => { window.__result.cancelled += 1; },
            stopTask: () => {}, stopping: false,
          }))));
    };
  });

  // Case 1: 单题单选，双击选项 2 → 立即提交且答案就是选项 2
  const p1 = JSON.stringify({ questions: [
    { header: 'Q', question: '随机三选一？', options: [{ label: '喝咖啡' }, { label: '提交存档' }, { label: '随便看看' }] },
  ] });
  await page.evaluate((json) => window.__mount(window.parseAskPayload(json), 'c1'), p1);
  await page.locator('.pi-eli').waitFor();
  await page.locator('.pi-eli__opt').nth(1).dblclick();
  await page.waitForTimeout(120);
  let r = await page.evaluate(() => window.__result);
  assert(r.answers && JSON.stringify(r.answers[0].answers) === JSON.stringify(['提交存档']), `single-choice dblclick submits that option: ${JSON.stringify(r)}`);

  // Case 2: 两题。双击第 1 题选项 1 → 推进到第 2 题（不提交）；第 2 题双击选项 A → 提交，两题答案齐全
  const p2 = JSON.stringify({ questions: [
    { header: '目标', question: '怎么改？', options: [{ label: '按清单' }, { label: '改 md' }] },
    { header: '范围', question: '选一个？', options: [{ label: '全部' }, { label: '最近' }] },
  ] });
  await page.evaluate((json) => window.__mount(window.parseAskPayload(json), 'c2'), p2);
  await page.locator('.pi-eli').waitFor();
  await page.locator('.pi-eli__opt').nth(0).dblclick();
  await page.waitForTimeout(100);
  assert(await page.evaluate(() => window.__result.answers) === null, 'first-question dblclick advances, not submits');
  assert(await page.locator('.pi-eli__pager-count').innerText() === '2 / 2', 'advanced to question 2');
  await page.locator('.pi-eli__opt').nth(1).dblclick();
  await page.waitForTimeout(120);
  r = await page.evaluate(() => window.__result);
  assert(r.answers && r.answers[0].answers[0] === '按清单' && r.answers[1].answers[0] === '最近', `both answers gathered: ${JSON.stringify(r.answers)}`);

  // Case 3: 多选题，双击「全部」 → 勾选并立即提交（含该项）
  const p3 = JSON.stringify({ questions: [
    { header: '范围', question: '勾选保留？', multiSelect: true, options: [{ label: '全部' }, { label: '最近' }] },
  ] });
  await page.evaluate((json) => window.__mount(window.parseAskPayload(json), 'c3'), p3);
  await page.locator('.pi-eli').waitFor();
  await page.locator('.pi-eli__opt').nth(0).dblclick();
  await page.waitForTimeout(120);
  r = await page.evaluate(() => window.__result);
  assert(r.answers && JSON.stringify(r.answers[0].answers) === JSON.stringify(['全部']), `multi dblclick checks+submits: ${JSON.stringify(r)}`);

  assert(errors.length === 0, 'no page errors: ' + errors.join(' | '));
  return 'PASS ask-card-doubleclick: single dblclick submits / multi-question dblclick advances then submits / multiSelect dblclick checks+submits';
}
