// 斜杠命令自愈：面板打开且命令列表为空时触发一次 onSlashCommandsEmpty（迟加载重拉）；
// 命令到位后展示且不再触发；关闭重开（仍空）会再次触发。Vite :5175。
// playwright-cli -s slashheal open http://127.0.0.1:5175 && playwright-cli -s slashheal run-code --filename tests/slash-commands-selfheal.browser.cjs
async (page) => {
  const assert = (ok, label) => { if (!ok) throw new Error(label); };
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.route('http://127.0.0.1:5175/slash-heal', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script>' }));
  await page.goto('http://127.0.0.1:5175/slash-heal');
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.setViewportSize({ width: 1100, height: 600 });
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
    window.healCalls = 0;
    const h = React.createElement;
    function Shell() {
      const [draft, setDraft] = React.useState('');
      const [commands, setCommands] = React.useState([]);
      // 模拟主进程 refreshCommands 到达：首次自愈请求后命令列表补全。
      React.useEffect(() => {
        if (window.healCalls === 1) setTimeout(() => setCommands([{ name: '/goal', description: '目标' }, { name: '/goal-resume', description: '续接' }]), 60);
      }, [window.healCalls]);
      const composer = h(Composer, {
        draftText: draft, onDraftChange: setDraft, sessionActive: true,
        modelId: 'anthropic/a1', modelGroups: [], reasoning: 'off', agentMode: 'agent', permissionMode: 'ask',
        slashCommands: commands, files: [], running: false, queued: 0, queue: [], demo: false, labels: zh,
        onSend: () => {}, onStop: () => {},
        onSlashCommandsEmpty: () => { window.healCalls += 1; },
      });
      return h('main', { className: 'pireplica', style: { height: '100vh', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' } },
        h('div', { style: { padding: '0 24px 20px' } }, composer));
    }
    createRoot(document.getElementById('root')).render(h(Shell));
  });

  await page.locator('.pi-composer').waitFor();
  const ta = page.locator('.pi-composer textarea');
  await ta.click();
  await ta.pressSequentially('/', { delay: 30 });
  await page.waitForTimeout(250);
  assert(await page.evaluate(() => window.healCalls) === 1, `empty panel triggers exactly one heal request (got ${JSON.stringify(await page.evaluate(() => window.healCalls))})`);
  // refreshCommands “到达”：列表补全并渲染 /goal 系列
  await page.waitForTimeout(200);
  const items = await page.evaluate(() => [...document.querySelectorAll('.pi-composer__popup [role="option"], .pi-composer__popup button')].map(b => b.textContent || ''));
  assert(items.some(t => t.includes('/goal')), `commands render after heal: ${JSON.stringify(items)}`);
  // 收起再重开（已有命令）：不再触发
  await ta.press('Backspace');
  await page.waitForTimeout(100);
  await ta.pressSequentially('/', { delay: 30 });
  await page.waitForTimeout(150);
  assert(await page.evaluate(() => window.healCalls) === 1, `no extra heal when commands exist (got ${JSON.stringify(await page.evaluate(() => window.healCalls))})`);
  assert(errors.length === 0, `no page errors: ${errors.join('; ')}`);
}
