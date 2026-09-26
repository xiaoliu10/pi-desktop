// Session-scoped ask_user_question: inline card in the conversation + sidebar "待用户确认" badge.
// Vite at :5175; open first: playwright-cli -s mq open about:blank
// then: playwright-cli -s mq run-code --filename tests/session-scoped-ask.browser.cjs
async (page) => {
  const assert = (ok, label) => { if (!ok) throw new Error(label); };
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.route('http://127.0.0.1:5175/ask-inline', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script>' }));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('http://127.0.0.1:5175/ask-inline');
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    const { InlineAskCard, ExtensionDialog } = await import('/pi/PiReplicaApp.tsx');
    const { Sidebar } = await import('/replica/shell/Sidebar.tsx');
    await import('/replica/tokens.css'); await import('/replica/chat/chat.css');
    await import('/replica/shell/sidebar.css'); await import('/replica/overlays/overlays.css'); await import('/pi/replica-app.css');
    window.localPi = { stop: async () => {}, answerDialog: async () => true };
    const ask = (id) => ({
      key: 'k2', generation: 'g1',
      request: { id, method: 'input', title: 'desktop-ask', placeholder: JSON.stringify({ questions: [
        { header: '实现方案', question: '采用哪种持久化方式？', options: [{ label: 'SQLite', description: '单文件' }, { label: 'JSON', description: '便于手工编辑' }] },
      ] }) },
    });
    const root = createRoot(document.getElementById('root'));
    window.renderAsk = () => root.render(React.createElement('main', { className: 'pireplica' },
      React.createElement('div', { style: { display: 'flex' } },
        React.createElement('aside', { style: { width: 260 } },
          React.createElement(Sidebar, {
            projects: [], temporarySessions: [
              { id: 'k1', title: '普通会话', updatedAt: Date.now() - 60000, source: 'desktop' },
              { id: 'k2', title: '实施计划', updatedAt: Date.now(), source: 'desktop', needsConfirm: 'userInput', needsConfirmCount: 1 },
            ], activeSessionId: 'k1', collapsed: false, version: 'pi 0',
            labels: { projects: '项目', sessions: '会话', search: '搜索', settings: '设置', plugins: '插件', notifications: '通知', readOnlyBadge: '只读' },
            onSelectSession: () => {}, onNewSession: () => {}, onToggleProject: () => {},
            onToggleCollapse: () => {}, onOpenSettings: () => {}, onOpenPlugins: () => {}, onToggleNotifications: () => {},
          })),
        React.createElement('div', { style: { flex: 1, padding: '12px 0' } },
          React.createElement(InlineAskCard, { dialog: ask('a1') })))));
    window.renderModal = () => root.render(React.createElement('main', { className: 'pireplica' },
      React.createElement(ExtensionDialog, { dialog: ask('a1') })));
  });

  // 1) Inline card: in-flow section, no overlay backdrop
  await page.evaluate(() => window.renderAsk());
  await page.locator('.pi-ask-inline').waitFor();
  const inline = await page.evaluate(() => {
    const card = document.querySelector('.pi-ask-inline');
    const overlay = document.querySelector('.pi-overlay');
    const cs = getComputedStyle(card);
    return { position: cs.position, hasOverlay: Boolean(overlay), text: card.textContent };
  });
  assert(inline.position !== 'fixed', `inline card must not be fixed: ${inline.position}`);
  assert(!inline.hasOverlay, 'inline ask must not render a global overlay');
  assert(inline.text.includes('采用哪种持久化方式'), 'inline ask shows the question');
  assert(inline.text.includes('待用户确认') === false, 'inline card is the question card, not the badge');
  await page.screenshot({ path: 'output/playwright/ask-inline-conversation.png' });

  // 2) Sidebar badge on the session row that has the pending ask; time slot replaced
  const badge = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.pi-sidebar__session')];
    const target = rows.find((r) => r.textContent.includes('实施计划'));
    const other = rows.find((r) => r.textContent.includes('普通会话'));
    return {
      targetBadge: Boolean(target?.querySelector('.pi-sidebar__confirm--userInput')),
      targetText: target?.querySelector('.pi-sidebar__confirm')?.textContent ?? '',
      targetTime: Boolean(target?.querySelector('.pi-sidebar__time')),
      otherBadge: Boolean(other?.querySelector('.pi-sidebar__confirm')),
      otherTime: Boolean(other?.querySelector('.pi-sidebar__time')),
    };
  });
  assert(badge.targetBadge, 'session with pending ask shows 待用户确认 badge');
  assert(badge.targetText.includes('待用户确认'), `badge text: ${badge.targetText}`);
  assert(!badge.targetTime, 'badge replaces the time slot');
  assert(!badge.otherBadge, 'session without pending ask has no badge');
  assert(badge.otherTime, 'session without pending ask keeps the time slot');

  // 3) Regression guard: ExtensionDialog for an ask payload still uses the modal markup,
  //    but PiReplicaApp no longer routes asks there (covered by unit test on isAskDialog filtering).
  assert(errors.length === 0, 'no page errors: ' + errors.join(' | '));
  return 'PASS session-scoped-ask: inline card in conversation (no overlay) + sidebar 待用户确认 badge replacing time';
}
