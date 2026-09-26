// Synthetic composer layout harness. Vite at :5175; playwright-cli run-code --filename tests/chat-composer-overflow.browser.cjs
// 复现 + 回归：workbench 打开（聊天列变窄）时 composer 工具行不得溢出卡片、不得顶到发送按钮。
async (page) => {
  const assert = (ok, label) => { if (!ok) throw new Error(label); };
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.route('http://127.0.0.1:5175/composer-overflow', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script>' }));
  await page.goto('http://127.0.0.1:5175/composer-overflow');
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    const { Composer } = await import('/replica/chat/ChatView.tsx');
    const { AccessModeMenu } = await import('/pi/AccessModeMenu.tsx');
    const { ComposerAdd, ThinkingMenu } = await import('/pi/ComposerTools.tsx');
    const { ContextUsageChip } = await import('/pi/ContextUsage.tsx');
    const { VoiceInputButton } = await import('/pi/VoiceInputButton.tsx');
    await import('/replica/tokens.css');
    await import('/replica/chat/chat.css');
    await import('/pi/replica-app.css');
    await import('/replica/workbench/workbench.css');
    const stream = () => ({ getTracks: () => [{ stop: () => {} }] });
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => stream() } });
    window.MediaRecorder = class {
      static isTypeSupported() { return true; }
      constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm'; }
      start() { this.state = 'recording'; }
      stop() { this.state = 'inactive'; queueMicrotask(() => { this.ondataavailable?.({ data: new Blob(['synthetic']) }); this.onstop?.(); }); }
    };
    window.localPi = {
      projectFiles: async () => [],
      composerSkills: async () => [],
      pickDocuments: async () => [],
      resourceRead: async () => ({ text: '' }),
      projectContext: async () => ({}),
      voiceConfig: async () => ({ activeId: 'a', models: [{ id: 'a', ready: true }] }),
      voiceTranscribe: async () => '转写文本',
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
    const root = createRoot(document.getElementById('root'));
    const LONG_MODEL = 'anthropic/claude-sonnet-4-5-20250929';
    const groups = [{ provider: 'Anthropic', models: [
      { id: LONG_MODEL, name: 'claude-sonnet-4-5-20250929', detail: '200K 上下文' },
      { id: 'anthropic/claude-opus-4-1', name: 'claude-opus-4-1', detail: '200K 上下文' },
    ] }];
    function Shell({ workbench, dark, running, demoPills }) {
      const [draft, setDraft] = React.useState('');
      const [mode, setMode] = React.useState('fullAccess');
      const [think, setThink] = React.useState('medium');
      const composer = React.createElement(Composer, {
        draftText: draft, onDraftChange: setDraft, sessionActive: true,
        modelId: LONG_MODEL, modelGroups: groups,
        reasoning: 'high', agentMode: 'agent', permissionMode: 'full',
        slashCommands: [], files: [], running, queued: 0, queue: [], demo: false, labels: zh,
        hideReasoning: !demoPills,
        addSlot: React.createElement(ComposerAdd, { cwd: '/mock/proj', disabled: false, onAdd: () => {} }),
        leftSlot: demoPills ? undefined : React.createElement(AccessModeMenu, { value: mode, disabled: false, changing: false, zh: true, onChange: async v => { setMode(v); return true; } }),
        reasoningSlot: React.createElement(ThinkingMenu, { value: think, levels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], disabled: false, onChange: setThink }),
        statusSlot: running ? React.createElement(ContextUsageChip, { usage: { tokens: 85400, contextWindow: 200000, percent: 42.7 }, zh: true, compact: true, model: LONG_MODEL }) : undefined,
        voiceSlot: append => React.createElement(VoiceInputButton, { labels: zh, zh: true, disabled: false, onTranscript: append, onError: () => {}, onNotConfigured: () => {} }),
        onSend: () => {}, onStop: () => {}, onPickModel: () => {}, onPickReasoning: () => {}, onPickAgentMode: () => {}, onPickPermission: () => {},
      });
      return React.createElement('main', { className: `pireplica${dark ? ' pireplica--dark' : ''}`, style: { display: 'flex', height: '100vh', '--pi-workbench-width': '415px' } },
        React.createElement('aside', { style: { width: '300px', flex: 'none', background: 'var(--pi-bg-sidebar)', borderRight: '1px solid var(--pi-border)' } }),
        React.createElement('div', { style: { flex: 1, minWidth: 0, display: 'flex', position: 'relative' } },
          React.createElement('div', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' } },
            React.createElement('div', { style: { flex: 1, minHeight: 0 } }),
            React.createElement('div', { style: { padding: '0 24px 20px' } }, composer)),
          workbench ? React.createElement('aside', { className: 'pi-workbench' },
            React.createElement('div', { className: 'pi-workbench__tabs' }, '工作台'),
            React.createElement('div', { className: 'pi-workbench__empty' }, 'workbench')) : null));
    }
    window.renderShell = opts => root.render(React.createElement(Shell, opts));
    // 几何测量：发送按钮与所有工具行子元素必须落在 composer 卡片内。
    window.measure = () => {
      const composer = document.querySelector('.pi-composer');
      const toolbar = document.querySelector('.pi-composer__toolbar');
      const send = document.querySelector('.pi-composer__send');
      const c = composer.getBoundingClientRect();
      const outside = [...toolbar.querySelectorAll('button, select')].map(el => {
        const b = el.getBoundingClientRect();
        return (b.right > c.right + 0.5 || b.left < c.left - 0.5)
          ? (typeof el.className === 'string' ? el.className : el.tagName) + ` [${Math.round(b.left)}..${Math.round(b.right)}]`
          : null;
      }).filter(Boolean);
      return {
        cardRight: Math.round(c.right), cardLeft: Math.round(c.left),
        sendRight: Math.round(send.getBoundingClientRect().right),
        toolbarScroll: toolbar.scrollWidth, toolbarClient: toolbar.clientWidth,
        rightScroll: document.querySelector('.pi-composer__right').scrollWidth,
        rightClient: document.querySelector('.pi-composer__right').clientWidth,
        wrapWidth: Math.round(document.querySelector('.pi-composer-wrap').getBoundingClientRect().width),
        outside,
      };
    };
  });

  const failures = [];
  const lines = [];
  const check = (label) => page.evaluate(() => window.measure()).then(m => {
    lines.push(`MEASURE ${label}: ${JSON.stringify(m)}`);
    if (m.outside.length) failures.push(`${label}: elements spill past card: ${m.outside.join(', ')}`);
    if (m.sendRight > m.cardRight) failures.push(`${label}: send button (${m.sendRight}) past card right edge (${m.cardRight})`);
    if (m.rightScroll > m.rightClient + 1) failures.push(`${label}: right group scrollWidth ${m.rightScroll} > clientWidth ${m.rightClient}`);
    return m;
  });

  // 场景 1：workbench 打开（415px）+ 1280 窗口 → 聊天列 ~565px，与用户报告一致。
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => window.renderShell({ workbench: true, dark: false, running: false, demoPills: false }));
  await page.locator('.pi-composer').waitFor();
  await check('workbench-open/1280/light');
  await page.screenshot({ path: 'output/playwright/composer-overflow-workbench-1280-light.png' });

  // 场景 2：中间档——wrap ≈ 567px（480~600）：推理 pill/待生效徽标收成 icon，模型名保留并省略号。
  // （<1180 时 workbench 变 overlay 不挤压聊天列，故用 1330 + 415 workbench 构造。）
  await page.setViewportSize({ width: 1330, height: 800 });
  await page.evaluate(() => window.renderShell({ workbench: true, dark: false, running: false, demoPills: false }));
  await page.locator('.pi-composer').waitFor();
  await check('workbench-open/1330/mid-tier');
  await page.screenshot({ path: 'output/playwright/composer-overflow-workbench-midtier-light.png' });

  // 场景 3：运行中（stop 形态 + 上下文用量环进入右组）+ 最宽 workbench 700。
  await page.setViewportSize({ width: 1440, height: 800 });
  await page.evaluate(() => document.querySelector('.pireplica').style.setProperty('--pi-workbench-width', '700px'));
  await page.evaluate(() => window.renderShell({ workbench: true, dark: false, running: true, demoPills: false }));
  await page.locator('.pi-composer__send--stop').waitFor();
  await check('workbench-700/1440/running-stop');
  await page.screenshot({ path: 'output/playwright/composer-overflow-running-stop-narrow.png' });
  await page.evaluate(() => document.querySelector('.pireplica').style.setProperty('--pi-workbench-width', '415px'));

  // 场景 4：暗色主题 + workbench + 1280（与场景 1 同档，验证双主题）。
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => window.renderShell({ workbench: true, dark: true, running: false, demoPills: false }));
  await page.locator('.pi-composer').waitFor();
  await check('workbench-open/1280/dark');
  await page.screenshot({ path: 'output/playwright/composer-overflow-workbench-1280-dark.png' });

  // 场景 5：无 workbench 对照组（1280），不得回归正常宽度。
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => window.renderShell({ workbench: false, dark: false, running: false, demoPills: false }));
  await page.locator('.pi-composer').waitFor();
  await check('no-workbench/1280/light');
  await page.screenshot({ path: 'output/playwright/composer-overflow-no-workbench-1280-light.png' });

  // 场景 6：demo 形态（左组 Agent/权限 pill + 右组推理 pill 同时出现）1180 无 workbench。
  await page.setViewportSize({ width: 1180, height: 800 });
  await page.evaluate(() => window.renderShell({ workbench: false, dark: false, running: false, demoPills: true }));
  await page.locator('.pi-composer').waitFor();
  await check('demo-pills/1100/light');

  // 交互回归：菜单仍可弹出且不被裁剪（1280 + workbench，非 overlay 模式）。
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => window.renderShell({ workbench: true, dark: false, running: false, demoPills: false }));
  await page.locator('.pi-composer').waitFor();
  await page.locator('.pi-composer__right .pi-composer__pill').first().click();
  await page.locator('.pi-composer__menu').waitFor();
  const menuVisible = await page.locator('.pi-composer__menu').evaluate(el => { const b = el.getBoundingClientRect(); return b.bottom > 0 && b.top >= 0; });
  assert(menuVisible, 'model menu still opens above composer');
  await page.screenshot({ path: 'output/playwright/composer-overflow-model-menu.png' });
  await page.mouse.click(80, 400); // 点击侧栏空白处：mousedown 外部关闭菜单
  await page.locator('.pi-composer__menu').waitFor({ state: 'detached' });
  await page.locator('.pi-access__trigger').click();
  await page.locator('.pi-access__menu').waitFor();
  await page.screenshot({ path: 'output/playwright/composer-overflow-access-menu.png' });
  await page.mouse.click(80, 400);

  // 语音 slot 交互：录音/停止仍可切换。
  await page.locator('.pi-composer__voice').click();
  await page.getByRole('button', { name: '停止录音', exact: true }).waitFor();
  await page.getByRole('button', { name: '停止录音', exact: true }).click();
  await page.locator('.pi-composer__voice').waitFor();

  assert(errors.length === 0, errors.join('\n'));
  if (failures.length) throw new Error('OVERFLOW:\n' + failures.join('\n') + '\n' + lines.join('\n'));
  return lines.join('\n') + '\nPASS: composer toolbar stays inside card with workbench open/closed, running stop morph, light/dark, demo pills; model/access menus and voice slot intact.';
}
