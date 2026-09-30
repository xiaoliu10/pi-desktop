// Run with the existing Vite UI preview on 5175:
// playwright-cli -s=board-dismiss run-code "$(< tests/subagent-dismissal.browser.cjs)"
async (page) => {
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  const url = 'http://127.0.0.1:5175/board-dismiss-harness';
  await page.route(url, route => route.fulfill({ contentType: 'text/html', body: '<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script>' }));
  const mount = async (reset = false) => {
    await page.goto(url);
    await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
    await page.evaluate(async reset => {
      const entry = await (await fetch('/main.tsx')).text();
      const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
      const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
      await import('/styles.css'); await import('/replica/tokens.css');
      const { ConversationStatusPanel } = await import('/pi/ConversationStatusPanel.tsx');
      const { usePiStore, sentConversationMessages } = await import('/pi/adapter.ts');
      const { projectSubagents } = await import('/pi/subagents.ts');
      const { registerSubagentAdapter } = await import('/pi/subagent-registry.ts');
      const storageKey = 'pi-test-board-dismiss-prefs';
      if (reset) localStorage.removeItem(storageKey);
      localStorage.removeItem('pi-status-collapsed');
      window.opened = []; window.saved = [];
      const child = (status, callId = status) => ({ id: `${callId}:${status}`, callId, status, agent: status, task: `${status} task`, mode: 'single', messages: [] });
      const children = ['running', 'queued', 'completed', 'failed', 'interrupted', 'recovered', 'skipped', 'unknown'].map(status => child(status));
      const mixed = [child('completed', 'chain'), child('running', 'chain')];
      registerSubagentAdapter({ id: 'dismissal-browser', detect: part => part.tool === 'dismissal-fixture', parse: part => part.resultDetails });
      const history = items => ({ branch: [
        { type: 'message', id: `call-${JSON.stringify(items)}`, message: { role: 'assistant', content: [{ type: 'toolCall', id: 'fixture', name: 'dismissal-fixture', arguments: {} }] } },
        { type: 'message', id: `result-${JSON.stringify(items)}`, message: { role: 'toolResult', toolCallId: 'fixture', toolName: 'dismissal-fixture', content: [], details: items } },
      ] });
      const histories = { a: history([...children, ...mixed]), b: history([child('completed')]), ended: history([child('failed', 'only-ended')]), live: history([child('running'), child('queued')]) };
      window.localPi = {
        saveDesktopSettings: async patch => { window.saved.push(patch); localStorage.setItem(storageKey, JSON.stringify(patch)); },
        history: async key => histories[key],
      };
      usePiStore.setState({ selectedKey: 'a', runs: [], sessions: [], live: {}, toolProgress: {}, sends: [], recoveredSubagents: [], subagentDismissed: undefined, history: histories.a, desktopPreferences: { projects: [], hiddenProjects: [], ...JSON.parse(localStorage.getItem(storageKey) || '{}') } });
      window.boardStore = usePiStore;
      window.boardSwitch = key => usePiStore.getState().selectSession(key);
      window.boardRefresh = () => usePiStore.setState({ history: structuredClone(histories[usePiStore.getState().selectedKey]) });
      function Fixture() {
        const s = usePiStore(), key = s.selectedKey;
        const dismissed = s.subagentDismissed ?? s.desktopPreferences.subagentDismissed?.[key] ?? [];
        const messages = sentConversationMessages(s.history?.branch ?? [], s.live[key], s.toolProgress[key], []);
        const subagents = projectSubagents(messages, false, s.recoveredSubagents).filter(c => !dismissed.includes(c.callId));
        return React.createElement('main', { className: 'pireplica', style: { minHeight: '100vh', padding: 24 } }, React.createElement(ConversationStatusPanel, {
          key, messages, running: false, subagents, onReview() {}, onRequest() {},
          onOpenSubagent: callId => window.opened.push(callId), onDismissSubagent: s.dismissSubagent, onDismissFinishedSubagents: s.dismissFinishedSubagents,
        }));
      }
      createRoot(document.getElementById('root')).render(React.createElement(Fixture));
    }, reset);
    await page.locator('.pi-status-heading').first().waitFor();
  };
  let checks = 0;
  const assert = (ok, message) => { if (!ok) throw Error(message); checks++; };
  const row = status => page.locator(`.pi-status-agent-row:has(.pi-status-agent[data-call-id="${status}"])`);
  const remove = status => row(status).locator('.pi-status-agent-remove');
  const clear = () => page.getByRole('button', { name: '清空已结束的子代理记录' });
  await page.setViewportSize({ width: 1100, height: 850 });
  await mount(true);
  assert(await page.locator('.pi-status-agent-row').count() === 10, 'all fixture children render');
  assert(await page.getByText('3 运行 · 7 已结束', { exact: true }).count() === 1, 'counts include live, queued and ended');
  assert(await page.locator('button button').count() === 0, 'no nested buttons');
  assert(await page.locator('.pi-status-agent-remove').count() === 6, 'only fully ended calls are removable');
  assert(await remove('running').count() === 0 && await remove('queued').count() === 0 && await remove('chain').count() === 0, 'idle parent never makes live or mixed calls dismissible');
  assert(await remove('completed').getAttribute('title') === '从列表移除（不删除会话文件）', 'destructive scope explained in title');
  await remove('completed').click();
  assert(await row('completed').count() === 0, 'single mouse removal');
  assert(await page.evaluate(() => opened.length) === 0, 'removal does not open detail');
  assert(await page.evaluate(() => document.activeElement?.dataset.callId) === 'running', 'focus moved to surviving row');
  assert(await page.getByText('3 运行 · 6 已结束', { exact: true }).count() === 1, 'counts update after removal');
  await remove('failed').focus(); await page.keyboard.press('Enter');
  assert(await row('failed').count() === 0, 'Enter removes');
  await remove('interrupted').focus(); await page.keyboard.press('Space');
  assert(await row('interrupted').count() === 0, 'Space removes');
  assert(await page.evaluate(() => opened.length) === 0, 'keyboard removal does not open detail');
  await row('running').locator('.pi-status-agent').click();
  assert(JSON.stringify(await page.evaluate(() => opened)) === '["running"]', 'separate detail button still works');
  await clear().click();
  assert(await page.locator('.pi-status-agent-row').count() === 4, 'bulk removes remaining ended calls but retains mixed call and live rows');
  assert(await page.getByText('3 运行 · 1 已结束', { exact: true }).count() === 1, 'bulk counts remain accurate');
  assert(await clear().count() === 0, 'bulk hidden when no safely removable calls');
  assert(JSON.stringify(await page.evaluate(() => opened)) === '["running"]', 'bulk does not open details');
  const saved = await page.evaluate(() => boardStore.getState().desktopPreferences.subagentDismissed);
  assert(saved.a.length === 6 && !saved.a.includes('chain') && !saved.a.includes('running') && !saved.a.includes('queued'), 'only ended call ids persisted');
  await page.evaluate(() => boardRefresh());
  assert(await page.locator('.pi-status-agent-row').count() === 4, 'history refresh does not restore hidden rows');
  await page.evaluate(() => boardSwitch('b'));
  await row('completed').waitFor();
  assert(await page.locator('.pi-status-agent-row').count() === 1, 'session B same callId is unaffected');
  await page.evaluate(() => boardSwitch('a'));
  await row('running').waitFor();
  assert(await row('completed').count() === 0, 'switching back restores dismissal scope');
  await mount();
  assert(await page.locator('.pi-status-agent-row').count() === 4, 'fresh renderer restores persisted preferences');
  await page.locator('.pi-status-rail').screenshot({ path: 'output/playwright/subagent-dismissal-desktop.png' });
  await page.evaluate(() => boardSwitch('ended'));
  await row('only-ended').waitFor();
  await clear().focus(); await page.keyboard.press('Enter');
  assert(await page.locator('.pi-status-agent-row').count() === 0, 'all-ended list can be cleared by keyboard');
  assert(await page.getByText('子代理', { exact: true }).count() === 0, 'empty subagent section disappears');
  assert(await page.evaluate(() => document.activeElement === document.querySelector('.pi-status-card header button')), 'last removal keeps focus on panel toggle');
  await page.evaluate(() => boardSwitch('live'));
  await row('running').waitFor();
  assert(await clear().count() === 0 && await page.locator('.pi-status-agent-remove').count() === 0, 'live-only list has no destructive controls');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => boardSwitch('b'));
  await page.getByRole('button', { name: '任务状态' }).click();
  await remove('completed').waitFor();
  const style = await remove('completed').evaluate(el => ({ opacity: getComputedStyle(el).opacity, visibility: getComputedStyle(el).visibility, rect: el.getBoundingClientRect().toJSON() }));
  assert(style.opacity === '1' && style.visibility === 'visible', 'mobile removal is visible without hover');
  assert(style.rect.width >= 28 && style.rect.height >= 28 && style.rect.right <= 390, 'mobile control has visible non-clipped hit target');
  assert(await page.locator('button button').count() === 0, 'mobile still has no nested buttons');
  assert(await page.locator('.pi-status-heading').filter({ hasText: '子代理' }).evaluate(el => getComputedStyle(el).fontWeight) === '600', 'bold heading retained');
  await page.locator('.pi-status-rail').screenshot({ path: 'output/playwright/subagent-dismissal-mobile.png' });
  await remove('completed').click();
  assert(await page.locator('.pi-status-agent-row').count() === 0, 'mobile click removes ended entry');
  assert(await page.evaluate(() => opened.length) === 0, 'mobile removal does not invoke detail');
  assert(errors.length === 0, errors.join('\n'));
  return { checks, errors, persisted: saved };
}
