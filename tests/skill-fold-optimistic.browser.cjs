// 运行中 /skill 展开消息的折叠回归（received send 未确认窗口不摊 XML 全文）。
// 真 store（usePiStore.init + rpc message_start）+ 真 TurnArticle + 生产 CSS（Vite :5175）。
// npx vite --host 127.0.0.1 --port 5175 --strictPort
// playwright-cli -s=skillfold open http://127.0.0.1:5175
// playwright-cli -s=skillfold run-code --filename tests/skill-fold-optimistic.browser.cjs
// 跑完 kill vite。
async (page) => {
  const assert = (ok, label) => { if (!ok) throw new Error(label); };
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  const url = 'http://127.0.0.1:5175/skill-fold-harness';
  await page.route(url, route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script>' }));
  await page.goto(url);
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.evaluate(async () => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    await import('/styles.css');
    await import('/replica/tokens.css');
    await import('/replica/chat/chat.css');
    await import('/pi/replica-app.css');
    const { usePiStore, sentConversationMessages } = await import('/pi/adapter.ts');
    const { executionTurns } = await import('/replica/chat/execution.ts');
    const { TurnArticle } = await import('/replica/chat/ChatView.tsx');
    window.__emit = null;
    // Hold history back until the live skill bubble has been inspected.
    window.localPi = {
      settingsSnapshot: () => Promise.reject('mock'), environment: () => Promise.reject('mock'),
      sessions: async () => [], runs: async () => [], archivedSessions: async () => [],
      onEvent: fn => { window.__emit = fn; return () => {}; },
      prompt: () => new Promise(() => {}), history: () => new Promise(resolve => { window.__resolveHistory = resolve; }),
    };
    const key = 'skill-fold-run';
    usePiStore.getState().init();
    await new Promise(r => setTimeout(r, 600));
    usePiStore.setState({
      selectedKey: key,
      runs: [{ key, generation: 'g1', cwd: '/mock', file: '/mock/session', status: 'idle', models: [], commands: [], pending: 0 }],
      history: { branch: [{ id: 'old-user', type: 'message', message: { role: 'user', content: 'old' } }] },
      sends: [], pendingPrompt: undefined, pendingPromptAt: undefined, sentAt: undefined,
      pendingSteer: {}, live: {}, toolProgress: {}, contextItems: [], draftText: '',
      connecting: false, changingAccessMode: false, error: undefined,
    });
    const skillText = '<skill name="auto-research" location="/Users/jason/.agents/skills/auto-research/SKILL.md">\nReferences are relative to /Users/jason/.agents/skills/auto-research.\n\n# Auto Research → 设计与判断\n\n技能正文段落，很长的一段说明文字。\n</skill>\n\n火山agent plan 可以查到用量信息吗？';
    usePiStore.getState().send('/skill:auto-research 火山agent plan 可以查到用量信息吗？');
    const message = { role: 'user', timestamp: 551, content: skillText };
    window.__emit({ type: 'rpc', key, generation: 'g1', event: { type: 'message_start', message } });
    window.__confirm = () => window.__resolveHistory({ branch: [...usePiStore.getState().history.branch, { type: 'message', id: 'skill-ack', message }] });
    await new Promise(r => setTimeout(r, 300));
    const labels = {
      you: '你', assistant: '助手', simulatedRun: '模拟', toolRunning: '运行中', toolDone: '完成',
      toolError: '出错', working: '工作中', queued: '已排队', copyMessage: '复制', copied: '已复制',
      editMessage: '编辑并重发', resend: '重发', cancel: '取消', viewImage: '查看原图',
      downloadImage: '下载图片', close: '关闭', details: '详情',
    };
    const root = createRoot(document.getElementById('root'));
    const render = () => {
      const s = usePiStore.getState();
      const messages = sentConversationMessages(s.history?.branch ?? [], s.live[key], s.toolProgress[key], s.sends ?? []);
      const turns = executionTurns(messages, 200);
      root.render(React.createElement('main', { className: 'pireplica' },
        React.createElement('div', { className: 'pi-chat' },
          React.createElement('div', { className: 'pi-chat__scroll' },
            React.createElement('div', { className: 'pi-chat__inner' },
              turns.map(t => React.createElement(TurnArticle, { key: t.id, m: t, liveTurn: false, labels })))))));
    };
    render();
    // store 订阅重渲（refreshHistory 失败后的重试拍也覆盖）
    window.__unsub = usePiStore.subscribe(() => render());
    window.__render = render;
  });
  // 断言 1：折叠 chip 存在、含技能名与提示文案
  const chip = page.locator('details.pi-msg__skill');
  await chip.waitFor({ timeout: 5000 });
  assert(await page.locator('article.pi-msg--user').count() === 2, 'expected the old message and exactly one new skill message');
  const chipText = await chip.locator('summary').textContent();
  assert(chipText && chipText.includes('auto-research') && chipText.includes('点开查看全文'), `chip 文案不符: ${chipText}`);
  // 断言 2：默认折叠（details 无 open），正文 XML 不可见
  const open = await chip.evaluate(el => el.open);
  assert(open === false, 'details 应默认折叠');
  const visible = await page.locator('.pi-chat__inner').innerText();
  assert(!visible.includes('<skill name='), 'XML 标签泄漏到可见正文');
  assert(!visible.includes('技能正文段落'), '技能全文在折叠态泄漏');
  assert(visible.includes('火山agent plan'), '用户指令不可见');
  // 断言 3：点开后全文可见（details 内容真实渲染）
  await chip.locator('summary').click();
  await page.waitForTimeout(200);
  const expanded = await page.locator('.pi-chat__inner').innerText();
  assert(expanded.includes('技能正文段落'), '点开后技能全文未显示');
  assert(expanded.includes('References are relative'), '点开后 References 行未显示');
  // 断言 4：多拍渲染稳定（refreshHistory 重试不清空/不泄漏）
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.__render());
  const late = await page.locator('.pi-chat__inner').innerText();
  assert(!late.includes('<skill name='), '后续渲染拍出现 XML 泄漏');
  assert((await page.locator('details.pi-msg__skill').count()) === 1, '折叠卡数量应为 1');
  await page.waitForFunction(() => typeof window.__resolveHistory === 'function');
  await page.evaluate(() => window.__confirm());
  await page.locator('article[data-msg="skill-ack"]').waitFor();
  assert(await page.locator('article.pi-msg--user').count() === 2, 'duplicate user message after history confirmation');
  assert(await chip.count() === 1, 'expected one skill chip after confirmation');
  assert(errors.length === 0, `pageerror: ${errors.join(' | ')}`);
  await page.screenshot({ path: 'output/playwright/skill-fold-optimistic.png' });
  await page.evaluate(() => window.__unsub && window.__unsub());
  return 'skill-fold optimistic UI: folded chip + no XML leak + expandable full text — all green';
}
