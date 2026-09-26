// ↑/↓ 发送历史 recall（ZCode 同款）。Vite at :5175; playwright-cli run-code --filename tests/composer-history.browser.cjs
// 回归：空输入↑↓回看历史、浏览态翻页/到底退出、有文字不接管、手动编辑退出浏览态、发送后历史追加由 PiReplicaApp 层负责。
async (page) => {
  const assert = (ok, label) => { if (!ok) throw new Error(label); };
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.route('http://127.0.0.1:5175/composer-history', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script>' }));
  await page.goto('http://127.0.0.1:5175/composer-history');
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
    const HISTORY = ['第一条消息', '第二次提问', '第三次提问'];
    const root = createRoot(document.getElementById('root'));
    function Shell() {
      const [draft, setDraft] = React.useState('');
      const [sent, setSent] = React.useState([]);
      window.__sent = sent;
      const composer = React.createElement(Composer, {
        draftText: draft, onDraftChange: setDraft, sessionActive: true,
        modelId: 'anthropic/a1', modelGroups: [{ provider: 'P', models: [{ id: 'p/m1', name: 'M-one' }] }],
        reasoning: 'low', agentMode: 'agent', permissionMode: 'full',
        slashCommands: [], files: [], running: false, queued: 0, queue: [], demo: false, labels: zh,
        hideReasoning: true,
        promptHistory: HISTORY,
        onSend: (text) => setSent((s) => [...s, text]), onStop: () => {},
        onPickModel: () => {}, onPickReasoning: () => {}, onPickAgentMode: () => {}, onPickPermission: () => {},
      });
      return React.createElement('main', { className: 'pireplica', style: { display: 'flex', height: '100vh' } },
        React.createElement('div', { style: { flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' } },
          React.createElement('div', { style: { padding: '0 24px 20px' } }, composer)));
    }
    root.render(React.createElement(Shell));
  });

  const ta = page.locator('.pi-composer textarea');
  await ta.waitFor();
  const value = () => ta.inputValue();
  const caretAtEnd = () => page.evaluate(() => { const el = document.querySelector('.pi-composer textarea'); return el.selectionStart === el.selectionEnd && el.selectionStart === el.value.length; });

  // 空输入 ↑ → 最新一条
  await ta.focus();
  await page.keyboard.press('ArrowUp');
  assert(await value() === '第三次提问', `ArrowUp from empty should recall newest, got "${await value()}"`);
  assert(await caretAtEnd(), 'caret should be at end after recall');

  // 继续 ↑ → 更旧
  await page.keyboard.press('ArrowUp');
  assert(await value() === '第二次提问', `2nd ArrowUp should recall older, got "${await value()}"`);
  await page.keyboard.press('ArrowUp');
  assert(await value() === '第一条消息', `3rd ArrowUp should recall oldest, got "${await value()}"`);
  // 到最旧再 ↑ 停住
  await page.keyboard.press('ArrowUp');
  assert(await value() === '第一条消息', 'ArrowUp at oldest should stay');

  // ↓ 往回走，到底退出恢复空草稿
  await page.keyboard.press('ArrowDown');
  assert(await value() === '第二次提问', `ArrowDown should go newer, got "${await value()}"`);
  await page.keyboard.press('ArrowDown');
  assert(await value() === '第三次提问', `ArrowDown should reach newest, got "${await value()}"`);
  await page.keyboard.press('ArrowDown');
  assert(await value() === '', `ArrowDown past newest should restore empty draft, got "${await value()}"`);

  // 有文字时 ↑ 不接管（多行光标行为保持）
  await ta.fill('正在编辑的草稿');
  await page.keyboard.press('ArrowUp');
  assert(await value() === '正在编辑的草稿', 'ArrowUp with text should NOT take over');

  // 进入浏览态后手动编辑 → 退出浏览态，再按 ↑ 不接管
  await ta.fill('');
  await page.keyboard.press('ArrowUp');
  assert(await value() === '第三次提问', 're-enter history mode');
  await ta.fill('第三次提问手改');
  await page.keyboard.press('ArrowUp');
  assert(await value() === '第三次提问手改', 'manual edit exits history mode; ArrowUp must not take over');

  // Enter 发送照常工作
  await ta.fill('');
  await page.keyboard.press('ArrowUp'); // 第三次提问
  await page.keyboard.press('Enter');
  await page.waitForTimeout(50);
  const sent = await page.evaluate(() => window.__sent);
  assert(sent.length === 1 && sent[0] === '第三次提问', `Enter should send recalled text, got ${JSON.stringify(sent)}`);

  await page.screenshot({ path: 'output/playwright/composer-history-recall.png' });
  assert(errors.length === 0, 'no page errors: ' + errors.join(' | '));
  return 'PASS composer-history: empty↑ newest / older / oldest clamp / down exit→empty / no-takeover with text / edit exits mode / enter sends recall';
}
