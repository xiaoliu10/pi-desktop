// Keyboard model/reasoning menu navigation. Vite at :5175; playwright-cli run-code --filename tests/composer-model-keys.browser.cjs
// 回归：模型菜单支持 ↑/↓ 高亮、Enter 选中、Escape 关闭；初始高亮定位到当前模型。
async (page) => {
  const assert = (ok, label) => { if (!ok) throw new Error(label); };
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.route('http://127.0.0.1:5175/model-keys', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script>' }));
  await page.goto('http://127.0.0.1:5175/model-keys');
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    const { Composer } = await import('/replica/chat/ChatView.tsx');
    await import('/replica/tokens.css');
    await import('/replica/chat/chat.css');
    await import('/pi/replica-app.css');
    window.localPi = {
      projectFiles: async () => [], composerSkills: async () => [], pickDocuments: async () => [],
      resourceRead: async () => ({ text: '' }), projectContext: async () => ({}),
      voiceConfig: async () => ({ activeId: null, models: [] }), voiceTranscribe: async () => '',
    };
    const zh = {
      placeholderSession: '随便问点什么', placeholderHome: '输入 / 使用命令 · 输入 @ 引用文件',
      send: '发送', stop: '停止', queued: '已排队', queueNow: '立即', queueEdit: '编辑', queueRemove: '删除',
      pendingSwitch: '待生效', agentMode: 'Agent', modeAgent: 'Agent', modePlan: 'Plan', modeGoal: 'Goal',
      permissionAsk: '每次询问', permissionAutoedit: '自动应用编辑', permissionFull: '完全访问',
      model: '模型', reasoning: '推理强度', reasoningOff: '关闭', reasoningLow: '低', reasoningMedium: '中', reasoningHigh: '高',
      attachDisabled: '预览暂不支持附件上传', voiceStart: '开始语音输入', voiceStop: '停止录音', voiceTranscribing: '转写中…',
      voiceNotConfigured: '语音输入需至少配置一个就绪的 ASR 模型', slashCommands: '命令', atFiles: '文件',
      demoBadge: '界面预览 · 演示数据', commandsEmpty: '没有匹配的命令', filesEmpty: '没有匹配的文件',
    };
    const groups = [
      { provider: 'Anthropic', models: [
        { id: 'anthropic/a1', name: 'A-one', detail: '200K' },
        { id: 'anthropic/a2', name: 'A-two', detail: '200K' },
      ] },
      { provider: 'OpenAI', models: [
        { id: 'openai/g1', name: 'G-one', detail: '128K' },
      ] },
    ];
    const root = createRoot(document.getElementById('root'));
    function Shell() {
      const [draft, setDraft] = React.useState('');
      const composer = React.createElement(Composer, {
        draftText: draft, onDraftChange: setDraft, sessionActive: true,
        modelId: 'anthropic/a1', modelGroups: groups,
        reasoning: 'low', agentMode: 'agent', permissionMode: 'full',
        slashCommands: [], files: [], running: false, queued: 0, queue: [], demo: false, labels: zh,
        hideReasoning: false,
        onSend: () => {}, onStop: () => {},
        onPickModel: (id) => { window.pickedModel = id; },
        onPickReasoning: (lv) => { window.pickedReasoning = lv; },
        onPickAgentMode: () => {}, onPickPermission: () => {},
      });
      return React.createElement('main', { className: 'pireplica', style: { display: 'flex', height: '100vh' } },
        React.createElement('div', { style: { flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' } },
          React.createElement('div', { style: { padding: '0 24px 20px' } }, composer)));
    }
    root.render(React.createElement(Shell));
  });

  await page.locator('.pi-composer').waitFor();

  // --- model menu ---
  await page.click('.pi-composer__pill--model');
  await page.locator('.pi-composer__menu').waitFor();
  // menu container should be focused so keydown reaches it
  const focusedIsMenu = await page.evaluate(() => document.activeElement && document.activeElement.classList.contains('pi-composer__menu'));
  assert(focusedIsMenu, 'model menu container should be focused on open');
  // initial highlight should land on the currently selected model (anthropic/a1)
  const activeOnOpen = await page.locator('.pi-composer__menurow--active span').first().innerText();
  assert(activeOnOpen.includes('A-one'), `initial active should be A-one, got ${activeOnOpen}`);

  // ArrowDown → move to A-two
  await page.keyboard.press('ArrowDown');
  let active = await page.locator('.pi-composer__menurow--active span').first().innerText();
  assert(active.includes('A-two'), `after ArrowDown active should be A-two, got ${active}`);
  // ArrowDown again → wraps to next provider G-one
  await page.keyboard.press('ArrowDown');
  active = await page.locator('.pi-composer__menurow--active span').first().innerText();
  assert(active.includes('G-one'), `after 2x ArrowDown active should be G-one, got ${active}`);
  // ArrowDown wraps to top (A-one)
  await page.keyboard.press('ArrowDown');
  active = await page.locator('.pi-composer__menurow--active span').first().innerText();
  assert(active.includes('A-one'), `wrap-around should return to A-one, got ${active}`);
  // ArrowUp wraps to bottom (G-one)
  await page.keyboard.press('ArrowUp');
  active = await page.locator('.pi-composer__menurow--active span').first().innerText();
  assert(active.includes('G-one'), `ArrowUp wrap should go to G-one, got ${active}`);

  // Enter selects highlighted (G-one) and closes the menu
  await page.keyboard.press('Enter');
  const picked = await page.evaluate(() => window.pickedModel);
  assert(picked === 'openai/g1', `Enter should pick openai/g1, got ${picked}`);
  const menuGone = await page.locator('.pi-composer__menu').count();
  assert(menuGone === 0, 'menu should close after Enter');

  // reopen + Escape closes
  await page.click('.pi-composer__pill--model');
  await page.locator('.pi-composer__menu').waitFor();
  await page.keyboard.press('Escape');
  assert(await page.locator('.pi-composer__menu').count() === 0, 'Escape should close model menu');

  // --- reasoning menu ---
  await page.click('.pi-composer__pill--reasoning');
  await page.locator('.pi-composer__menu').waitFor();
  // current reasoning is 'low' → index 1
  let rActive = await page.locator('.pi-composer__menurow--active span').first().innerText();
  assert(rActive.includes('低'), `reasoning initial active should be 低 (low), got ${rActive}`);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  const pickedR = await page.evaluate(() => window.pickedReasoning);
  assert(pickedR === 'medium', `reasoning Enter should pick medium, got ${pickedR}`);

  assert(errors.length === 0, 'no page errors: ' + errors.join(' | '));
  return 'PASS model-keys: arrow navigation + enter select + escape close + reasoning nav';
}
