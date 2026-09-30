// 斜杠提问卡键盘导航回归：①AskQuestionCard（ask_user_question）↑↓/Tab/Enter/Space；
// ②扩展 select 停靠卡（ExtensionDialog）↑↓/Tab 移动高亮、Enter 选中提交、hover 同步。
// playwright-cli -s askkb2 open http://127.0.0.1:5175 && playwright-cli -s askkb2 run-code --filename tests/ask-keyboard.browser.cjs
async (page) => {
  const assert = (ok, label) => { if (!ok) throw new Error(label); };
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.setViewportSize({ width: 1100, height: 640 });
  await page.route('http://127.0.0.1:5175/ask-kb', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script>' }));
  await page.goto('http://127.0.0.1:5175/ask-kb');
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    const { AskQuestionCard, ExtensionDialog } = await import('/pi/PiReplicaApp.tsx');
    await import('/replica/tokens.css'); await import('/replica/chat/chat.css'); await import('/pi/replica-app.css');
    window.localPi = { stop: async () => ({ steering: [], followUp: [] }), respond: (key, gen, response) => { window.respondLog.push(response); } };
    window.respondLog = [];
    window.answers = null;
    const { createRoot: cr } = { createRoot };
    const askPayload = { questions: [{ header: '实现方案', question: '选一个方案', options: [{ label: '方案一' }, { label: '方案二' }, { label: '方案三' }] }] };
    window.renderAsk = (overrides) => {
      window.answers = null;
      const q = { ...askPayload.questions[0], ...(overrides || {}) };
      createRoot(document.getElementById('root')).render(React.createElement('main', { className: 'pireplica', style: { padding: 30 } },
        React.createElement(AskQuestionCard, { payload: { questions: [q] }, zh: true, onAnswer: a => { window.answers = a; }, onCancel: () => {}, stopTask: () => {}, stopping: false })));
    };
    window.renderSelect = async (options) => {
      window.respondLog = [];
      // answerDialog 按 request.id 在 store.dialogs 里定位，需先注入同 id 对话框。
      const { usePiStore } = await import('/pi/adapter.ts');
      usePiStore.setState({ dialogs: [{ key: 'k1', generation: 'g1', request: { id: 'r1', method: 'select', title: 'Completion auditor (currently enabled)', options: options || ['方案一', '方案二', '方案三'] } }] });
      createRoot(document.getElementById('root')).render(React.createElement('main', { className: 'pireplica', style: { padding: 30 } },
        React.createElement(ExtensionDialog, { dialog: { key: 'k1', generation: 'g1', request: { id: 'r1', method: 'select', title: 'Completion auditor (currently enabled)', options: options || ['方案一', '方案二', '方案三'] } } })));
    };
  });

  // --- ① AskQuestionCard：容器自动聚焦 + ↓↓Enter 选中第二项提交 ---
  await page.evaluate(() => window.renderAsk());
  await page.locator('.pi-eli').waitFor();
  await page.waitForTimeout(120);
  assert(await page.evaluate(() => document.activeElement?.classList?.contains('pi-eli')), 'ask card container should auto-focus');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(120);
  const answers = await page.evaluate(() => window.answers);
  assert(answers?.[0]?.answers?.[0] === '方案二', `↓↓+Enter should pick 方案二, got ${JSON.stringify(answers)}`);
  // 多选题 Space 勾选（multiSelect 行为 checkbox，aria-checked；单选为 option/aria-selected）
  await page.evaluate(() => window.renderAsk({ multiSelect: true }));
  await page.waitForTimeout(80);
  await page.keyboard.press('ArrowDown'); // 一次 ↓：-1 → 高亮第一项
  await page.keyboard.press('Space');
  let askSelected = await page.evaluate(() => [...document.querySelectorAll('.pi-eli__opt')].map(b => b.getAttribute('aria-checked')));
  assert(askSelected[0] === 'true', `Space should toggle option 1, got ${JSON.stringify(askSelected)}`);
  await page.keyboard.press('Space');
  askSelected = await page.evaluate(() => [...document.querySelectorAll('.pi-eli__opt')].map(b => b.getAttribute('aria-checked')));
  assert(askSelected[0] === 'false', `Space again should untoggle, got ${JSON.stringify(askSelected)}`);

  // --- ② 扩展 select 停靠卡：容器聚焦 + ↓↓Enter 提交第三项 + hover 同步 ---
  await page.evaluate(() => window.renderSelect());
  await page.waitForTimeout(100);
  await page.locator('.pi-extdock').waitFor();
  await page.waitForTimeout(120);
  assert(await page.evaluate(() => document.activeElement?.classList?.contains('pi-extdock')), 'select dock card should auto-focus');
  const activeFirst = await page.evaluate(() => [...document.querySelectorAll('.pi-connectmodal__options .pi-btn')].findIndex(b => b.classList.contains('pi-extdock__option--active')));
  assert(activeFirst === 0, `first option highlighted initially, got ${activeFirst}`);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  const activeThird = await page.evaluate(() => [...document.querySelectorAll('.pi-connectmodal__options .pi-btn')].findIndex(b => b.classList.contains('pi-extdock__option--active')));
  assert(activeThird === 2, `↓↓ highlights third option, got ${activeThird}`);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(120);
  const respondLog = await page.evaluate(() => window.respondLog);
  assert(respondLog.length === 1 && respondLog[0].value === '方案三', `Enter should submit highlighted option, got ${JSON.stringify(respondLog)}`);
  // 鼠标 hover 同步高亮
  const opt = page.locator('.pi-connectmodal__options .pi-btn').first();
  await opt.hover();
  const activeHover = await page.evaluate(() => [...document.querySelectorAll('.pi-connectmodal__options .pi-btn')].findIndex(b => b.classList.contains('pi-extdock__option--active')));
  assert(activeHover === 0, `hover syncs highlight, got ${activeHover}`);
  assert(errors.length === 0, `no page errors: ${errors.join('; ')}`);
}
