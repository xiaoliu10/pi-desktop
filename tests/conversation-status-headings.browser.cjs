// Run against the existing Vite preview on 5175:
// playwright-cli -s=status-headings run-code "$(< tests/conversation-status-headings.browser.cjs)"
async (page) => {
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  const url = 'http://127.0.0.1:5175/status-headings-harness';
  await page.route(url, route => route.fulfill({ contentType: 'text/html', body: '<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script>' }));
  await page.setViewportSize({ width: 1100, height: 850 });
  await page.goto(url);
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    await import('/styles.css'); await import('/replica/tokens.css');
    const { ConversationStatusPanel } = await import('/pi/ConversationStatusPanel.tsx');
    localStorage.removeItem('pi-status-collapsed');
    window.localPi = { gitStatus: async () => ({ repository: true, branch: 'main', branches: ['main'], added: 12, removed: 3, untracked: 0, binary: 0, ahead: 0, behind: 0 }) };
    const props = {
      cwd: '/mock', running: false, onReview() {}, onRequest() {}, onOpenTerminal() {}, onOpenSubagent() {}, onOpenPlan() {},
      planAvailable: true, planTitle: '状态面板标题样式',
      stats: { tokens: { input: 1200, output: 300, cacheRead: 100, cacheWrite: 0, total: 1600 }, totalMessages: 8, toolCalls: 3 },
      subagents: [
        { id: 'a', callId: 'a', agent: 'explorer', task: '检查标题与状态颜色', mode: 'single', status: 'running', messages: [] },
        { id: 'b', callId: 'b', agent: 'tester', task: '验证主题适配', mode: 'single', status: 'completed', messages: [] },
      ],
      messages: [{ id: 'm', role: 'assistant', parts: [{ kind: 'tool', id: 't', callId: 't', tool: 'desktop_update_plan', phase: 'result', status: 'done', detailLines: [JSON.stringify({ plan: [{ step: '检查标题', status: 'completed' }, { step: '验证深色主题', status: 'in_progress' }, { step: '普通待处理行', status: 'pending' }] })] }] }],
    };
    createRoot(document.getElementById('root')).render(React.createElement('main', { className: 'pireplica', style: { minHeight: '100vh', padding: 24 } }, React.createElement(ConversationStatusPanel, props)));
  });
  await page.getByText('Git 工具', { exact: true }).waitFor();
  let checks = 0;
  const assert = (ok, message) => { if (!ok) throw Error(message); checks++; };
  const results = [];
  for (const theme of ['light', 'dark']) {
    await page.locator('.pireplica').evaluate((el, theme) => el.classList.toggle('pireplica--dark', theme === 'dark'), theme);
    const result = await page.evaluate(() => {
      const card = document.querySelector('.pi-status-card');
      const headings = [...card.querySelectorAll('.pi-status-heading')];
      const style = el => { const s = getComputedStyle(el); return { color: s.color, weight: s.fontWeight }; };
      const headingStyles = headings.map(el => ({ text: el.textContent, ...style(el) }));
      const others = [...card.querySelectorAll('*')].filter(el => !headings.includes(el));
      const before = others.map(style);
      headings.forEach(el => el.classList.remove('pi-status-heading'));
      const after = others.map(style);
      headings.forEach(el => el.classList.add('pi-status-heading'));
      return { headings: headingStyles, primary: getComputedStyle(card).color, unchanged: JSON.stringify(before) === JSON.stringify(after), otherCount: others.length };
    });
    assert(JSON.stringify(result.headings.map(h => h.text)) === JSON.stringify(['Git 工具', '终端', '子代理', '会话统计', '计划', '进程']), `${theme}: exactly the six intended headings`);
    for (const heading of result.headings) {
      assert(heading.weight === '600', `${theme}: ${heading.text} has weight 600`);
      assert(heading.color === result.primary, `${theme}: ${heading.text} uses theme primary text`);
    }
    assert(result.unchanged, `${theme}: all non-heading colors and weights are unchanged`);
    await page.locator('.pi-status-rail').screenshot({ path: `output/playwright/status-headings-${theme}.png` });
    results.push({ theme, ...result });
  }
  assert(results[0].primary !== results[1].primary, 'primary text adapts to the theme');
  assert(errors.length === 0, errors.join('\n'));
  return { checks, errors, results };
}
