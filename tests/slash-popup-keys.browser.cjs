// 斜杠命令/技能候选列表键盘导航回归：↑/↓ 移动高亮（循环）、过滤重置到第一项、Enter 选中。
// 用户反馈「技能列表支持键盘上下翻好像还是不行」：旧实现把高亮存进 ref（↑/↓ 改 ref 不触发
// 重渲染，高亮冻结），且渲染期无条件重置为 0。修复后为 state + 按 kind/query 变化重置。
// 运行：npx vite --port 5175 --host 127.0.0.1 后
// playwright-cli -s slash-popup-keys open about:blank; run-code --filename tests/slash-popup-keys.browser.cjs
async (page) => {
  const assert = (ok, label) => { if (!ok) throw new Error(label); };
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.setViewportSize({ width: 900, height: 800 });
  await page.route('http://127.0.0.1:5175/slash-popup-keys', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script>' }));
  await page.goto('http://127.0.0.1:5175/slash-popup-keys');
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
      projectFiles: async () => ['README.md', 'src/index.ts'], composerSkills: async () => [], pickDocuments: async () => [],
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
    const COMMANDS = Array.from({ length: 12 }, (_, i) => {
      const n = String(i + 1).padStart(2, '0');
      return { name: '/skill-' + n, description: '技能 ' + n };
    });
    const root = createRoot(document.getElementById('root'));
    function Shell() {
      const [draft, setDraft] = React.useState('');
      window.__draft = draft;
      return React.createElement('main', { className: 'pireplica', style: { display: 'flex', height: '100vh' } },
        React.createElement(Composer, {
          draftText: draft, onDraftChange: setDraft, sessionActive: true,
          modelId: 'anthropic/a1', modelGroups: [{ provider: 'P', models: [{ id: 'p/m1', name: 'M-one' }] }],
          reasoning: 'low', agentMode: 'agent', permissionMode: 'full',
          slashCommands: COMMANDS, files: [], running: false, queued: 0, queue: [], demo: false, labels: zh,
          hideReasoning: true,
          onSend: () => {}, onStop: () => {},
          onPickModel: () => {}, onPickReasoning: () => {}, onPickAgentMode: () => {}, onPickPermission: () => {},
        }));
    }
    root.render(React.createElement(Shell));
  });
  await page.locator('textarea').waitFor();
  await page.click('textarea');
  await page.keyboard.type('/');
  await page.locator('.pi-composer__popup').waitFor();
  const opts = page.locator('.pi-composer__popup .pi-composer__opt');
  assert(await opts.count() === 12, '12 candidates rendered');
  const selIndex = async () => {
    const n = await opts.count();
    for (let i = 0; i < n; i++) if (await opts.nth(i).getAttribute('aria-selected') === 'true') return i;
    return -1;
  };
  assert(await selIndex() === 0, 'initial highlight is the first item');
  await page.keyboard.press('ArrowDown');
  assert(await selIndex() === 1, 'ArrowDown moves highlight to 1 (ref 冻结回归)');
  await page.keyboard.press('ArrowDown');
  assert(await selIndex() === 2, 'ArrowDown moves highlight to 2');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  assert(await selIndex() === 11, 'ArrowUp wraps to the last item');
  // 过滤收窄候选 → 高亮重置到第一项（'2' 只命中 skill-02 / skill-12）
  await page.keyboard.type('2');
  await page.waitForTimeout(50);
  const filtered = await opts.count();
  assert(filtered === 2, `filter '2' narrows to 2 candidates (got ${filtered})`);
  assert(await selIndex() === 0, 'highlight resets to first after filtering');
  // Enter 选中当前高亮项
  await page.keyboard.press('ArrowDown');
  assert(await selIndex() === 1, 'highlight moves to 1 within filtered list');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(450); // setText→onDraftChange 有 200ms 防抖
  const draft = await page.evaluate(() => window.__draft);
  assert(String(draft).includes('/skill-12'), `Enter picks the highlighted command (draft=${JSON.stringify(draft)})`);
  assert(errors.length === 0, `no page errors: ${errors.join('; ')}`);
}
