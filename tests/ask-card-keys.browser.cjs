// ask 卡 ZCode ElicitationDialog 键盘交互：Tab/↑↓ 移焦点、Enter 推进/提交、Space 勾选多选、Esc 忽略、翻页器。
// Vite at :5175; playwright-cli -s askkeys open about:blank; run-code --filename tests/ask-card-keys.browser.cjs
async (page) => {
  const assert = (ok, label) => { if (!ok) throw new Error(label); };
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.setViewportSize({ width: 900, height: 760 });
  await page.route('http://127.0.0.1:5175/ask-keys', route => route.fulfill({ contentType: 'text/html', body: '<html><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script></body></html>' }));
  await page.goto('http://127.0.0.1:5175/ask-keys');
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    const { AskQuestionCard, parseAskPayload } = await import('/pi/PiReplicaApp.tsx');
    await import('/replica/tokens.css'); await import('/replica/chat/chat.css'); await import('/pi/replica-app.css');
    window.localPi = { stop: async () => {}, answerDialog: async () => true };
    const payload = parseAskPayload(JSON.stringify({ questions: [
      { header: '修改目标', question: '你想怎么修改这个目的？', options: [
        { label: '以审计清单为准（推荐）', description: '把目标改为对照清单持续复核' },
        { label: '直接修改 md', description: '修改文档本身内容' },
      ] },
      { header: '范围', question: '勾选要保留的部分？', multiSelect: true, options: [{ label: '全部' }, { label: '最近' }] },
    ] }));
    window.__result = { answers: null, cancelled: 0 };
    const root = createRoot(document.getElementById('root'));
    root.render(React.createElement('main', { className: 'pireplica', style: { padding: 24 } },
      React.createElement('section', { className: 'pi-ask-inline' },
        React.createElement(AskQuestionCard, {
          payload, zh: true,
          onAnswer: (a) => { window.__result.answers = a; },
          onCancel: () => { window.__result.cancelled += 1; },
          stopTask: () => {}, stopping: false,
        }))));
  });
  const card = page.locator('.pi-eli');
  await card.waitFor();

  // 空输入按 Enter：当前题未作答 → 不推进
  await card.focus();
  await page.keyboard.press('Enter');
  assert(await page.locator('.pi-eli__pager-count').innerText() === '1 / 2', 'unanswered Enter must not advance');

  // ↓ 选中选项1 → Enter 视作选中并推进到第 2 题
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  assert(await page.locator('.pi-eli__pager-count').innerText() === '2 / 2', 'Enter with focus on option selects it and advances');
  // 第二题是多选：页码显示且问题为多选
  assert(await page.locator('.pi-eli__check').count() >= 2, 'question 2 shows checkboxes');

  // ↓↓ Space 勾选两个选项
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Space');
  const checks = await page.evaluate(() => [...document.querySelectorAll('.pi-eli__check--on')].length);
  assert(checks === 2, `Space should check options, got ${checks}`);

  // Enter 提交全部 → answers 收齐两题
  await page.keyboard.press('Enter');
  const result = await page.evaluate(() => window.__result);
  assert(result.answers && result.answers.length === 2, 'submit answers both questions');
  assert(result.answers[0].answers[0] === '以审计清单为准（推荐）', `q1 answer: ${JSON.stringify(result.answers[0])}`);
  assert(JSON.stringify(result.answers[1].answers) === JSON.stringify(['全部', '最近']), `q2 answers: ${JSON.stringify(result.answers[1])}`);

  // 重新渲染测 Esc 忽略 + 自定义行
  await page.evaluate(async () => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    const { AskQuestionCard, parseAskPayload } = await import('/pi/PiReplicaApp.tsx');
    const payload = parseAskPayload(JSON.stringify({ questions: [{ header: 'Q', question: '单题？', options: [{ label: 'A' }, { label: 'B' }] }] }));
    window.__result2 = { answers: null, cancelled: 0 };
    const root2 = createRoot(document.getElementById('root'));
    root2.render(React.createElement('main', { className: 'pireplica', style: { padding: 24 } },
      React.createElement('section', { className: 'pi-ask-inline' },
        React.createElement(AskQuestionCard, {
          payload, zh: true,
          onAnswer: (a) => { window.__result2.answers = a; },
          onCancel: () => { window.__result2.cancelled += 1; },
          stopTask: () => {}, stopping: false,
        }))));
  });
  await page.locator('.pi-eli').waitFor();
  // 自定义回答行（编号 3.）输入文字 → 该题已答 → Enter 提交，回答含自定义文本
  await page.click('.pi-eli__input');
  await page.keyboard.type('自定义答案文字');
  await page.keyboard.press('Enter');
  const r2 = await page.evaluate(() => window.__result2);
  assert(r2.answers && JSON.stringify(r2.answers[0].answers) === JSON.stringify(['自定义答案文字']), `custom answer submits: ${JSON.stringify(r2.answers)}`);

  // Esc 忽略
  await page.evaluate(() => { window.__result2 = { answers: null, cancelled: 0 }; });
  await page.reload();
  await page.waitForTimeout(300);
  await page.evaluate(async () => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    const { AskQuestionCard, parseAskPayload } = await import('/pi/PiReplicaApp.tsx');
    const payload = parseAskPayload(JSON.stringify({ questions: [{ header: 'Q', question: '单题？', options: [{ label: 'A' }, { label: 'B' }] }] }));
    window.__result2 = { answers: null, cancelled: 0 };
    const root3 = createRoot(document.getElementById('root'));
    window.localPi = { stop: async () => {}, answerDialog: async () => true };
    root3.render(React.createElement('main', { className: 'pireplica', style: { padding: 24 } },
      React.createElement('section', { className: 'pi-ask-inline' },
        React.createElement(AskQuestionCard, {
          payload, zh: true,
          onAnswer: (a) => { window.__result2.answers = a; },
          onCancel: () => { window.__result2.cancelled += 1; },
          stopTask: () => {}, stopping: false,
        }))));
  });
  await page.locator('.pi-eli').waitFor();
  await page.locator('.pi-eli').focus();
  await page.keyboard.press('Escape');
  const r3 = await page.evaluate(() => window.__result2);
  assert(r3.cancelled === 1, `Escape should dismiss, got ${JSON.stringify(r3)}`);

  await page.screenshot({ path: 'output/playwright/ask-card-keys.png' });
  assert(errors.length === 0, 'no page errors: ' + errors.join(' | '));
  return 'PASS ask-card-keys: enter-noadvance unanswered / focus+enter selects&advances / space checks / submit gathers all / custom row / escape dismisses';
}
