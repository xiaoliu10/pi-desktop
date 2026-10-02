// 图像生成区块 + 生图模式。Vite at :5175; playwright-cli run-code --filename tests/composer-image-menu.browser.cjs
// 回归：模型菜单出现「图像生成」区块（受同一筛选影响）；点击进入生图模式（按钮/占位符切换、
// 再点同一行退出）；键盘上下跨聊天模型与生图行循环；生图模式发送走 onImageGenerate 并清空输入。
async (page) => {
  const assert = (ok, label) => { if (!ok) throw new Error(label); };
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.route('http://127.0.0.1:5175/image-menu', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script>' }));
  await page.goto('http://127.0.0.1:5175/image-menu');
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
      placeholderImage: '描述想生成的图像…', imageGen: '图像生成', imageGenBusy: '正在生成图像…',
      send: '发送', stop: '停止', queued: '已排队', queueNow: '立即', queueEdit: '编辑', queueRemove: '删除',
      pendingSwitch: '待生效', agentMode: 'Agent', modeAgent: 'Agent', modePlan: 'Plan', modeGoal: 'Goal',
      permissionAsk: '每次询问', permissionAutoedit: '自动应用编辑', permissionFull: '完全访问',
      model: '模型', reasoning: '推理强度', reasoningOff: '关闭', reasoningLow: '低', reasoningMedium: '中', reasoningHigh: '高',
      attachDisabled: '预览暂不支持附件上传', voiceStart: '开始语音输入', voiceStop: '停止录音', voiceTranscribing: '转写中…',
      voiceNotConfigured: '语音输入需至少配置一个就绪的 ASR 模型', slashCommands: '命令', atFiles: '文件',
      demoBadge: '界面预览 · 演示数据', commandsEmpty: '没有匹配的命令', filesEmpty: '没有匹配的文件',
    };
    const state = { target: null, prompts: [], picks: [] };
    window.__state = state;
    const groups = [{ provider: 'OpenAI', models: [{ id: 'openai/g1', name: 'G-one', detail: '128K' }] }];
    const imageModels = [
      { key: 'openrouter/flux.2-pro', provider: 'openrouter', providerName: 'openrouter', name: 'FLUX.2 Pro' },
      { key: 'zai/cogview-4', provider: 'zai', providerName: '智谱 Z.ai', name: 'CogView-4' },
    ];
    const root = createRoot(document.getElementById('root'));
    function Shell() {
      const [draft, setDraft] = React.useState('');
      const composer = React.createElement(Composer, {
        draftText: draft, onDraftChange: setDraft, sessionActive: true,
        modelId: 'openai/g1', modelGroups: groups,
        imageModels, imageTarget: state.target,
        onPickImageModel: (k) => { state.picks.push(k); state.target = k; force(); },
        onImageGenerate: async (prompt) => { state.prompts.push(prompt); },
        reasoning: 'off', agentMode: 'agent', permissionMode: 'ask',
        slashCommands: [], files: [], running: false, queued: 0, queue: [], demo: false, labels: zh,
        hideReasoning: true,
        onSend: () => {}, onStop: () => {},
        onPickModel: (id) => { state.target = null; state.pickedModel = id; state.target = null; force(); },
        onPickReasoning: () => {}, onPickAgentMode: () => {}, onPickPermission: () => {},
      });
      const [, setTick] = React.useState(0);
      const force = () => setTick(t => t + 1);
      return React.createElement('main', { className: 'pireplica', style: { display: 'flex', height: '100vh' } },
        React.createElement('div', { style: { flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' } },
          React.createElement('div', { style: { padding: '0 24px 20px' } }, composer)));
    }
    root.render(React.createElement(Shell));
  });

  await page.locator('.pi-composer').waitFor();

  // --- menu shows the 图像生成 section ---
  await page.click('.pi-composer__pill--model');
  await page.locator('.pi-composer__menu').waitFor();
  const section = await page.locator('.pi-composer__menugroup', { hasText: '图像生成' }).count();
  assert(section === 1, 'image-gen section header should render');
  const imageRows = await page.locator('.pi-composer__menurow--sub', { hasText: 'FLUX.2 Pro' }).count();
  assert(imageRows === 1, 'FLUX.2 Pro row should render');

  // --- filter reaches image rows ---
  await page.fill('.pi-composer__menuinput', 'cogview');
  await page.waitForTimeout(50);
  const cog = await page.locator('.pi-composer__menurow--sub', { hasText: 'CogView-4' }).count();
  assert(cog === 1, 'filter should keep CogView-4');
  const fluxGone = await page.locator('.pi-composer__menurow--sub', { hasText: 'FLUX.2 Pro' }).count();
  assert(fluxGone === 0, 'filter should drop FLUX.2 Pro');
  await page.fill('.pi-composer__menuinput', '');

  // --- click enters image mode; pill + placeholder switch ---
  await page.locator('.pi-composer__menurow--sub', { hasText: 'FLUX.2 Pro' }).click();
  await page.waitForTimeout(50);
  const pillText = await page.locator('.pi-composer__pill--model span').first().innerText();
  assert(pillText.includes('图像生成') && pillText.includes('FLUX.2 Pro'), `pill should show image mode, got ${pillText}`);

  const ta = page.locator('.pi-composer__input');
  await ta.fill('一只戴墨镜的柴犬');
  await page.locator('.pi-composer__send').click();
  await page.waitForTimeout(80);
  const st = await page.evaluate(() => window.__state);
  assert(st.prompts.length === 1 && st.prompts[0] === '一只戴墨镜的柴犬', 'submit should route to onImageGenerate');
  const cleared = await page.evaluate(() => document.querySelector('.pi-composer__input').value);
  assert(cleared === '', 'input should clear after a successful generation');
  const busyPlaceholderGone = await page.locator('.pi-composer__input');
  assert((await busyPlaceholderGone.getAttribute('placeholder'))?.includes('生成的图像'), 'placeholder should stay in image mode');

  // --- picking a chat model exits image mode ---
  await page.click('.pi-composer__pill--model');
  await page.locator('.pi-composer__menu').waitFor();
  await page.locator('.pi-composer__menurow--sub', { hasText: 'G-one' }).first().click();
  await page.waitForTimeout(50);
  const pillAfter = await page.locator('.pi-composer__pill--model span').first().innerText();
  assert(pillAfter.includes('G-one') && !pillAfter.includes('图像生成'), `picking a chat model should exit image mode, got ${pillAfter}`);
  const st2 = await page.evaluate(() => window.__state);
  assert(st2.picks.includes('openrouter/flux.2-pro'), 'image pick should have been recorded');

  // --- re-enter via keyboard: ArrowDown cycles across chat + image rows, Enter picks ---
  await page.click('.pi-composer__pill--model');
  await page.locator('.pi-composer__menu').waitFor();
  // current highlight: G-one (row 0) → next is FLUX.2 Pro (first image row)
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(50);
  const pillKb = await page.locator('.pi-composer__pill--model span').first().innerText();
  assert(pillKb.includes('图像生成'), `keyboard pick should enter image mode, got ${pillKb}`);

  assert(errors.length === 0, `page errors: ${errors.join('; ')}`);
}
