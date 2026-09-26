// Run: playwright-cli -s=send-regression run-code --filename tests/pi-send-boundaries.browser.cjs
// Requires Vite on 127.0.0.1:5175. Synthetic data only; no Electron or user files.
async (page) => {
  const assert = (ok, label) => { if (!ok) throw new Error(label); };
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.setViewportSize({ width: 1000, height: 720 });
  await page.route('http://127.0.0.1:5175/send-test', route => route.fulfill({ contentType: 'text/html', body: '<html><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script></body></html>' }));
  await page.goto('http://127.0.0.1:5175/send-test');
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    const { ChatView } = await import('/replica/chat/ChatView.tsx');
    const { replicaLabels } = await import('/replica/i18n.ts');
    const { usePiStore, sentConversationMessages } = await import('/pi/adapter.ts');
    await import('/replica/tokens.css'); await import('/replica/chat/chat.css');
    const style = document.createElement('style'); style.textContent = 'body{margin:0}.pireplica{height:100vh;display:flex;flex-direction:column}.pi-chat{flex:1;min-height:0}'; document.head.appendChild(style);
    window.store = usePiStore;
    window.mock = { prompts: [], histories: [] };
    window.localPi = {
      prompt: (...args) => new Promise((resolve, reject) => window.mock.prompts.push({ args, resolve, reject })),
      history: () => new Promise(resolve => window.mock.histories.push(resolve)),
    };
    window.branch = Array.from({ length: 30 }, (_, i) => ({ id: 'old-' + i, type: 'message', message: { role: i % 2 ? 'assistant' : 'user', content: '历史消息 ' + i + '\n\n' + '用于滚动验证。'.repeat(35) } }));
    usePiStore.setState({ selectedKey: 'mock', runs: [{ key: 'mock', status: 'idle', generation: 'g', pending: 0 }], history: { branch: window.branch }, sends: [], connecting: false, draftText: '', contextItems: [], live: {}, toolProgress: { mock: [{ toolCallId: 'old-tool', name: 'bash', text: 'OLD_TOOL_RESULT', status: 'done' }] } });
    window.send = text => usePiStore.getState().send(text);
    function App() {
      const s = usePiStore(); const sends = s.sends || [];
      return React.createElement('main', { className: 'pireplica' }, React.createElement(ChatView, {
        messages: sentConversationMessages(s.history?.branch || [], s.live.mock, s.toolProgress.mock, sends),
        scrollRequest: sends.at(-1)?.id, sending: sends.some(s => !s.confirmedId), labels: replicaLabels('zh').chat, demo: false,
      }));
    }
    createRoot(document.getElementById('root')).render(React.createElement(App));
  });
  const scroll = page.locator('.pi-chat__scroll'); await scroll.waitFor();
  const bottom = () => scroll.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop < 5);
  const lastUser = () => page.locator('.pi-chat__inner > article').last().getAttribute('class');
  for (let round = 1; round <= 2; round++) {
    await scroll.hover(); await page.mouse.wheel(0, -1600);
    // wheel() returns before Chromium dispatches the scroll; let this gesture finish before Send.
    await page.waitForTimeout(250);
    await page.waitForFunction(() => { const el = document.querySelector('.pi-chat__scroll'); return el.scrollHeight - el.clientHeight - el.scrollTop > 300; });
    await page.evaluate(n => window.send('新消息-' + n), round);
    await page.getByText('新消息-' + round, { exact: true }).waitFor();
    assert((await lastUser()).includes('pi-msg--user'), `round ${round}: new user last before IPC`);
    await page.waitForFunction(() => { const el = document.querySelector('.pi-chat__scroll'); return el.scrollHeight - el.clientHeight - el.scrollTop < 5; });
    // Leave IPC unresolved for a full second. No old progress after the user.
    await page.waitForTimeout(1100);
    assert(await bottom(), `round ${round}: slow IPC stays bottom`);
    assert((await lastUser()).includes('pi-msg--user'), 'no trailing old work');
    await page.screenshot({ path: `output/playwright/send-round-${round}.png` });
    await page.evaluate(n => { window.mock.prompts[n - 1].resolve(); }, round);
    await page.waitForFunction(n => window.mock.histories.length >= n, round);
    await page.evaluate(n => {
      window.branch.push({ id: 'confirmed-' + n, type: 'message', message: { role: 'user', content: '新消息-' + n } });
      window.mock.histories[n - 1]({ branch: [...window.branch] });
    }, round);
    await page.waitForFunction(n => window.store.getState().sends.at(-1).confirmedId === 'confirmed-' + n, round);
    assert(await page.getByText('新消息-' + round, { exact: true }).count() === 1, 'no duplicate after ack');
    // Real wheel input pauses following; subsequent current-turn growth must not yank back.
    await scroll.hover(); await page.mouse.wheel(0, -1400);
    await page.waitForFunction(() => document.querySelector('.pi-chat__scroll').scrollHeight - document.querySelector('.pi-chat__scroll').clientHeight - document.querySelector('.pi-chat__scroll').scrollTop > 300);
    const top = await scroll.evaluate(el => el.scrollTop);
    await page.evaluate(n => {
      const s = window.store.getState(); const id = s.sends.at(-1).id;
      window.store.setState({ live: { mock: { ...s.live.mock, ['reply-' + n]: { role: 'assistant', _turnId: id, content: '本轮回复\n\n'.repeat(80) } } } });
    }, round);
    await page.waitForTimeout(300);
    assert(Math.abs(await scroll.evaluate(el => el.scrollTop) - top) < 5, 'manual scroll survives stream growth');
    assert(!await bottom(), 'manual scroll not forced bottom');
  }
  // Attachment-only send is visible immediately; rollback preserves attachment and scroll position.
  await page.evaluate(() => {
    window.store.setState({ contextItems: [{ id: 'img', name: 'pixel.png', path: '', text: '', kind: 'image', image: { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' } }] });
    window.send('');
  });
  await page.locator('.pi-chat__inner > article').last().locator('img').waitFor();
  assert(await bottom(), 'attachment forces bottom');
  await page.screenshot({ path: 'output/playwright/send-attachment.png' });
  await scroll.hover(); await page.mouse.wheel(0, -1000); await page.waitForTimeout(200);
  const top = await scroll.evaluate(el => el.scrollTop);
  await page.evaluate(() => window.mock.prompts[2].reject(new Error('synthetic offline')));
  await page.waitForFunction(() => window.store.getState().error === 'synthetic offline');
  await page.waitForTimeout(200);
  assert(await page.evaluate(() => window.store.getState().contextItems.length === 1 && window.store.getState().sends.length === 2), 'attachment rollback');
  assert(Math.abs(await scroll.evaluate(el => el.scrollTop) - top) < 5, 'rollback does not replay old scroll request');
  await page.screenshot({ path: 'output/playwright/send-boundaries.png' });
  assert(errors.length === 0, 'browser errors: ' + errors.join('\n'));
  console.log('PASS: two slow IPC rounds, immediate last user, old tools before user, stable acknowledgement, wheel-up during growth, attachment-only and failure rollback');
}
