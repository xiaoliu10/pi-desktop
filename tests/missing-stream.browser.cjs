// Synthetic host only; mounts the real PiReplicaApp and drives its actual store/IPC handler.
// Vite :5175; playwright-cli -s=missing-stream run-code --filename tests/missing-stream.browser.cjs
async (page) => {
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.setViewportSize({ width: 1280, height: 900 });
  const url = 'http://127.0.0.1:5175/missing-stream-harness';
  await page.route(url, route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script>' }));
  await page.goto(url);
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    await import('/styles.css'); await import('/replica/tokens.css');
    const { default: App, usePiStore } = await import('/pi/PiReplicaApp.tsx');
    window.store = usePiStore;
    const user = (id, content) => ({ id, type: 'message', message: { role: 'user', content } });
    window.branch = [user('old', 'Synthetic previous question')];
    window.newUser = user('new', 'Synthetic consumed question');
    window.run = { key: 'synthetic-stream', generation: 'synthetic-generation', cwd: '/synthetic', status: 'running', models: [], commands: [], pending: 1, queue: [{ text: 'Synthetic consumed question', behavior: 'followUp', pendingSync: true }] };
    window.localPi = {
      settingsSnapshot: async () => { throw Error('synthetic settings disabled'); },
      environment: async () => { throw Error('synthetic discovery disabled'); },
      sessions: async () => [], runs: async () => [window.run], archivedSessions: async () => [],
      onEvent: fn => { window.emit = fn; }, history: async () => ({ branch: window.branch }),
      prompt: async () => { throw Error('Synthetic test must not issue prompts'); },
      listFiles: async () => [], externalApps: async () => [], projectBranch: async () => null,
      gitStatus: async () => ({ isRepo: false, files: [] }),
    };
    usePiStore.getState().init();
    await new Promise(resolve => setTimeout(resolve, 0));
    usePiStore.setState({ ready: true, selectedKey: window.run.key, runs: [window.run], history: { branch: window.branch }, sends: [], live: {}, toolProgress: {}, view: 'chat', lang: 'zh', error: undefined, workbenchOpen: false });
    window.rpc = event => window.emit({ type: 'rpc', key: window.run.key, generation: window.run.generation, event });
    createRoot(document.getElementById('root')).render(React.createElement(App));
  });
  let checks = 0;
  const assert = (ok, message) => { if (!ok) throw Error(message); checks++; };
  await page.getByText('Synthetic previous question', { exact: true }).waitFor();
  await page.evaluate(() => {
    window.rpc({ type: 'agent_start' });
    window.rpc({ type: 'message_start', message: { role: 'user', content: 'Synthetic consumed question' } });
    window.rpc({ type: 'message_start', message: { role: 'assistant', timestamp: 901, content: [] } });
  });
  await page.locator('.pi-waiting-process').waitFor();
  assert(await page.getByText('Synthetic consumed question', { exact: true }).count() >= 1, 'consumed boundary appears before disk update');
  await page.evaluate(() => window.rpc({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'Synthetic streamed thinking' } }));
  await page.waitForFunction(() => !document.querySelector('.pi-waiting-process'));
  assert(await page.locator('.pi-waiting-process').count() === 0, 'thinking removes WaitingProcess before disk catches up');
  await page.evaluate(async () => { window.branch = [...window.branch, window.newUser]; await window.store.getState().refreshConversation(); });
  assert(await page.locator('.pi-waiting-process').count() === 0, 'history reconciliation does not move thinking back to previous turn');
  const order = await page.evaluate(() => {
    const state = window.store.getState(), owner = state.live[window.run.key]['901']._turnId;
    return { owner: state.sends.find(s => s.id === owner)?.confirmedId, users: document.querySelectorAll('.pi-msg--user').length };
  });
  assert(order.owner === 'new', 'live stream explicitly owns the consumed user after reconciliation');
  await page.evaluate(() => {
    window.rpc({ type: 'queue_update', steering: [], followUp: [] });
    window.emit({ type: 'run', run: { ...window.run, queue: [], pending: 0 } });
  });
  assert(await page.evaluate(() => window.store.getState().runs[0].pending === 0 && window.store.getState().runs[0].queue.length === 0), 'authoritative empty queue clears pendingSync');
  assert(await page.locator('.pi-waiting-process').count() === 0, 'queue reconciliation preserves visible processing');
  // Read older content while a queued user is consumed: only a local send
  // may force the scroll position back to the bottom.
  await page.evaluate(() => {
    window.branch = Array.from({ length: 24 }, (_, i) => ({ id: 'read-' + i, type: 'message', message: { role: 'user', content: ('Reading older history ' + i + ' ').repeat(30) } }));
    window.store.setState({ history: { branch: window.branch }, sends: [], live: {}, toolProgress: {} });
  });
  await page.waitForTimeout(200);
  await page.locator('.pi-chat__scroll').hover();
  await page.mouse.wheel(0, -1200);
  await page.waitForTimeout(300);
  const readingTop = await page.locator('.pi-chat__scroll').evaluate(el => el.scrollTop);
  assert(await page.locator('.pi-chat__jumpbottom').count() === 1, 'reader is detached from bottom');
  await page.evaluate(() => {
    window.localPi.history = async () => { throw Error('synthetic disk failure'); };
    window.rpc({ type: 'message_start', message: { role: 'user', timestamp: 902, content: 'Consumed while reading' } });
  });
  await page.waitForTimeout(600);
  assert(Math.abs(await page.locator('.pi-chat__scroll').evaluate(el => el.scrollTop) - readingTop) < 5, 'received boundary does not force scroll');
  await page.evaluate(() => window.rpc({ type: 'agent_settled' }));
  await page.waitForTimeout(600);
  assert(await page.locator('.pi-chat__working').count() === 0, 'failed history after settlement does not leave idle UI working');
  assert(await page.locator('.pi-waiting-process').count() === 0, 'received boundary is not sending');
  assert(await page.getByText('Consumed while reading', { exact: true }).count() === 1, 'received user remains visible despite failed disk refresh');
  await page.evaluate(() => {
    window.localPi.prompt = () => new Promise(() => {});
    window.store.getState().send('Actual local send');
  });
  await page.waitForTimeout(200);
  assert(await page.locator('.pi-chat__scroll').evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop < 5), 'actual local send still forces bottom');
  assert(await page.locator('.pi-chat__working').count() === 1, 'actual local send still shows sending state');
  await page.locator('.pi-waiting-process > summary').click();
  assert(await page.getByText('本轮当前没有可展示的思考或工具过程。计时依据本地任务状态，不代表已验证请求仍在运行；长上下文会话下模型首个响应可能需要较长时间，请稍候。', { exact: true }).isVisible(), 'waiting disclosure describes this turn and local status');
  await page.evaluate(() => { window.localPi.history = async () => ({ branch: window.branch }); });
  await page.getByRole('button', { name: '重新同步过程', exact: true }).click();
  await page.getByText('已刷新磁盘中保存的会话内容；这不代表已验证请求仍在运行。', { exact: true }).waitFor();
  assert(await page.locator('.pi-chat__working').count() === 1, 'disk refresh does not claim to have verified the pending local request');
  await page.screenshot({ path: 'output/playwright/missing-stream-regression.png' });
  assert(errors.length === 0, errors.join('\n'));
  return { checks, errors, syntheticHost: true, realApp: true };
}
