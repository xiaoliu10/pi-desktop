// Synthetic component test; Vite at :5189. No production sessions loaded.
// playwright-cli -s=live-transcript run-code --filename tests/subagent-live-transcript.browser.cjs
async (page) => {
  const assert = (ok, label) => { if (!ok) throw new Error(label); };
  const errors = []; page.on('pageerror', error => errors.push(String(error)));
  await page.setViewportSize({ width: 900, height: 720 });
  await page.route('http://127.0.0.1:5189/live-transcript', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script>' }));
  await page.goto('http://127.0.0.1:5189/live-transcript');
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    const { SubagentPanel } = await import('/pi/SubagentPanel.tsx');
    const { usePiStore } = await import('/pi/adapter.ts');
    await import('/replica/tokens.css'); await import('/replica/chat/chat.css');
    usePiStore.setState({ lang: 'zh', selectedKey: 'a'.repeat(64) });
    window.__calls = 0;
    window.__transcriptResponse = { messages: [
      { role: 'assistant', content: [{ type: 'text', text: 'LIVE TRANSCRIPT INITIAL' }] },
      { role: 'assistant', content: [{ type: 'toolCall', id: 'read-live', name: 'read', arguments: { path: 'fixture.txt' } }] },
      { role: 'toolResult', toolCallId: 'read-live', toolName: 'read', content: [{ type: 'text', text: 'tool output' }] },
    ], truncated: false };
    window.localPi = { subagentChildTranscript: async () => { window.__calls++; return window.__transcriptResponse; } };
    const root = createRoot(document.getElementById('root'));
    window.__render = (status, id = 'child') => root.render(React.createElement('main', { className: 'pireplica' }, React.createElement(SubagentPanel, {
      key: id, children: [{ id, callId: 'call', childKey: 'single', agent: 'code-reviewer', task: 'Live transcript fixture', mode: 'workflow', status, messages: [] }],
      initialCall: 'call', parentRunning: true, onClose() {}, onStop() {},
    })));
    window.__render('running');
  });
  await page.getByText('LIVE TRANSCRIPT INITIAL', { exact: true }).waitFor();
  await page.locator('.pi-subagents__working').waitFor({ state: 'visible' });
  assert(await page.locator('.pi-subagents__transcript').innerText().then(s => s.includes('LIVE TRANSCRIPT INITIAL')), 'running transcript visible');
  await page.evaluate(() => { window.__transcriptResponse.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'LIVE TRANSCRIPT APPENDED' }] }); });
  await page.getByText('LIVE TRANSCRIPT APPENDED', { exact: true }).waitFor({ timeout: 8000 });
  const process = page.locator('.pi-subagents__transcript .pi-execution').first();
  if (await process.count() && await process.getAttribute('open') === null) await process.locator(':scope > summary').click();
  await page.screenshot({ path: 'output/playwright/live-subagent-transcript.png' });
  const calls = await page.evaluate(() => window.__calls);
  // A transient read failure must not erase previously visible progress.
  await page.evaluate(() => { window.__transcriptResponse = { error: 'read-failed' }; });
  await page.waitForFunction(previous => window.__calls > previous, calls, { timeout: 8000 });
  assert(await page.getByText('LIVE TRANSCRIPT APPENDED', { exact: true }).count() === 1, 'read failure preserves last transcript');
  await page.evaluate(() => {
    window.__transcriptResponse = { messages: [{ role: 'assistant', content: [{ type: 'text', text: 'COMPLETED TRANSCRIPT' }] }], truncated: false };
    window.__render('completed');
  });
  await page.getByText('COMPLETED TRANSCRIPT', { exact: true }).waitFor();
  await page.locator('.pi-subagents__working').waitFor({ state: 'detached' });
  await page.evaluate(() => { window.__transcriptResponse = { error: 'outside-sessions-root' }; window.__render('running', 'denied'); });
  await page.getByText('子会话转录路径未通过安全校验，已拒绝读取。', { exact: true }).waitFor();
  assert(errors.length === 0, errors.join('\n'));
  return 'PASS live transcript, appended progress, transient-error retention, completion, explicit safety error';
}
