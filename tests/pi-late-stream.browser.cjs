// playwright-cli -s=late-stream run-code --filename tests/pi-late-stream.browser.cjs
// Vite at :5175; synthetic IPC only. No Electron, accounts or session files.
async (page) => {
  const assert = (ok, label) => { if (!ok) throw new Error(label); };
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.setViewportSize({ width: 1000, height: 720 });
  await page.route('http://127.0.0.1:5175/late-stream-test', route => route.fulfill({ contentType: 'text/html', body: '<html><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script></body></html>' }));
  await page.goto('http://127.0.0.1:5175/late-stream-test');
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
    window.store = usePiStore; window.mock = { histories: [], prompts: [] };
    window.localPi = {
      settingsSnapshot: async () => { throw Error('mock'); }, environment: async () => { throw Error('mock'); },
      sessions: async () => [], runs: async () => [], archivedSessions: async () => [],
      onEvent: fn => { window.emit = fn; },
      prompt: () => new Promise(resolve => window.mock.prompts.push(resolve)),
      history: () => new Promise(resolve => window.mock.histories.push(resolve)),
    };
    usePiStore.getState().init();
    await Promise.resolve(); await Promise.resolve();
    window.run = { key: 'mock', status: 'idle', generation: 'g', pending: 0, cwd: '/synthetic', models: [], commands: [] };
    window.branch = Array.from({ length: 30 }, (_, i) => ({ id: 'old-' + i, type: 'message', message: { role: i % 2 ? 'assistant' : 'user', content: '历史消息 ' + i + '\n\n' + '用于滚动验证。'.repeat(35) } }));
    usePiStore.setState({ selectedKey: 'mock', runs: [window.run], history: { branch: [...window.branch] }, sends: [], connecting: false, draftText: '', contextItems: [], live: {}, toolProgress: {} });
    window.rpc = event => window.emit({ type: 'rpc', key: 'mock', generation: 'g', event });
    window.setRunStatus = status => { window.run = { ...window.run, status }; window.emit({ type: 'run', run: window.run }); };
    function App() {
      const s = usePiStore(); const sends = s.sends || []; const run = s.runs.find(r => r.key === 'mock');
      return React.createElement('main', { className: 'pireplica' }, React.createElement('button', { onClick: () => s.send('新消息-' + (sends.length + 1)) }, '发送'), React.createElement(ChatView, {
        messages: sentConversationMessages(s.history?.branch || [], s.live.mock, s.toolProgress.mock, sends),
        scrollRequest: sends.at(-1)?.id, sending: sends.some(s => !s.confirmedId), running: run?.status === 'running', runTiming: run?.timing,
        sendingAt: s.sentAt?.at, labels: replicaLabels('zh').chat, demo: false,
      }));
    }
    createRoot(document.getElementById('root')).render(React.createElement(App));
  });
  const scroll = page.locator('.pi-chat__scroll'); await scroll.waitFor();
  const lastIsUser = async () => (await page.locator('.pi-chat__inner > article').last().getAttribute('class')).includes('pi-msg--user');
  for (let n = 1; n <= 3; n++) {
    await page.evaluate(n => {
      window.setRunStatus('idle');
      window.rpc({ type: 'message_start', message: { role: 'assistant', timestamp: n * 1000, content: [] } });
      window.rpc({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: '旧轮思考-' + n } });
      window.rpc({ type: 'tool_execution_start', toolCallId: 'tool-' + n, toolName: 'bash', args: { command: 'echo synthetic' } });
    }, n);
    await page.waitForTimeout(200);
    await scroll.hover(); await page.mouse.wheel(0, -1600); await page.waitForTimeout(250);
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await page.getByText('新消息-' + n, { exact: true }).waitFor();
    assert(await lastIsUser(), 'send places user after all previous process');
    await page.waitForFunction(() => { const e = document.querySelector('.pi-chat__scroll'); return e.scrollHeight - e.clientHeight - e.scrollTop < 5; });
    await page.evaluate(n => {
      window.run.timing = { startedAt: Date.now() }; window.setRunStatus('running');
      window.rpc({ type: 'agent_start' });
      window.rpc({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: '迟到旧过程-' + n } });
      window.rpc({ type: 'tool_execution_end', toolCallId: 'tool-' + n, toolName: 'bash', result: { content: '旧结果-' + n } });
    }, n);
    await page.waitForTimeout(1100);
    assert(await lastIsUser(), 'late delta after agent_start must not move old execution below user');
    assert(await page.locator('article .pi-spinner').count() === 0, 'old execution is not live');
    await page.screenshot({ path: `output/playwright/late-stream-${n}-pending.png` });
    await page.waitForFunction(() => window.mock.histories.length > 0);
    await page.evaluate(n => {
      window.branch.push({ id: 'user-' + n, type: 'message', message: { role: 'user', content: '新消息-' + n } });
      window.mock.histories.shift()({ branch: [...window.branch] });
    }, n);
    await page.waitForFunction(n => window.store.getState().sends.at(-1).confirmedId === 'user-' + n, n);
    await page.evaluate(n => {
      const message = { role: 'assistant', timestamp: n * 1000, content: [{ type: 'thinking', thinking: '旧轮思考-' + n }, { type: 'text', text: '旧轮最终总结-' + n }] };
      window.rpc({ type: 'message_end', message });
      window.branch.splice(window.branch.length - 1, 0, { id: 'answer-' + n, type: 'message', message });
    }, n);
    await page.waitForTimeout(200);
    assert(await lastIsUser(), 'summary without tool result stays before user');
    await page.waitForFunction(() => window.mock.histories.length > 0);
    await page.evaluate(() => window.mock.histories.shift()({ branch: [...window.branch] }));
    await page.waitForTimeout(200);
    assert(await page.getByText('旧轮最终总结-' + n, { exact: true }).count() === 1, 'history handoff has one summary');
    assert(await page.getByText('旧轮最终总结-' + n, { exact: true }).isVisible(), 'final summary must not be folded by trailing orphan tools');
    assert(await page.getByText('新消息-' + n, { exact: true }).count() === 1, 'history handoff has one user');
    assert(await lastIsUser(), 'history handoff keeps last user');
    await page.screenshot({ path: `output/playwright/late-stream-${n}-saved.png` });
  }
  await page.evaluate(() => {
    window.rpc({ type: 'message_start', message: { role: 'assistant', timestamp: 4000, content: [] } });
    window.rpc({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '真实新轮输出' } });
  });
  await page.getByText('真实新轮输出', { exact: true }).waitFor();
  assert(!await lastIsUser(), 'real new output is allowed after user');
  // Start another stream before an explicitly identified old delta arrives.
  await page.evaluate(() => { window.setRunStatus('idle'); window.store.getState().send('新消息-4'); window.rpc({ type: 'agent_start' }); });
  await page.getByText('新消息-4', { exact: true }).waitFor();
  await page.waitForFunction(() => window.mock.histories.length > 0);
  await page.evaluate(() => {
    window.branch.push({ id: 'user-4', type: 'message', message: { role: 'user', content: '新消息-4' } });
    window.mock.histories.shift()({ branch: [...window.branch] });
  });
  await page.waitForFunction(() => window.store.getState().sends.at(-1).confirmedId === 'user-4');
  await page.evaluate(() => {
    window.rpc({ type: 'message_start', message: { role: 'assistant', timestamp: 5000, model: 'metadata-model', content: [] } });
    window.rpc({ type: 'message_update', message: { role: 'assistant', timestamp: 5000, content: [{ type: 'text', text: '新流完整快照' }] }, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '快照' } });
    window.rpc({ type: 'message_update', message: { role: 'assistant', timestamp: 4000 }, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '旧流迟到增量' } });
    window.rpc({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '继续' } });
  });
  await page.getByText('新流完整快照继续', { exact: true }).waitFor();
  assert(await page.evaluate(() => {
    const live = window.store.getState().live.mock;
    const articles = [...document.querySelectorAll('.pi-chat__inner > article')];
    const oldIndex = articles.findIndex(e => e.textContent.includes('旧流迟到增量'));
    const userIndex = articles.findIndex(e => e.textContent.includes('新消息-4'));
    return live['5000'].timestamp === 5000 && live['5000'].model === 'metadata-model'
      && oldIndex >= 0 && userIndex > oldIndex
      && !JSON.stringify(live['5000']).includes('旧流迟到增量');
  }), 'identified old delta keeps old owner and does not corrupt new stream/metadata');
  for (const behavior of ['followUp', 'steer']) {
    await page.evaluate(behavior => {
      window.setRunStatus('running');
      window.store.setState({ behavior });
      window.rpc({ type: 'tool_execution_start', toolCallId: 'queue-old-' + behavior, toolName: 'read', args: {} });
      window.sendCount = window.store.getState().sends.length;
      window.store.getState().send('队列用户-' + behavior);
    }, behavior);
    assert(await page.evaluate(() => window.store.getState().sends.length === window.sendCount), 'queued sends do not create optimistic boundaries');
    await page.evaluate(behavior => {
      window.branch.push({ id: 'queued-' + behavior, type: 'message', message: { role: 'user', content: '队列用户-' + behavior } });
      // Resolve the real store history refresh, not a projected message fixture.
      window.mock.prompts.pop()();
    }, behavior);
    await page.waitForFunction(() => window.mock.histories.length > 0);
    await page.evaluate(() => window.mock.histories.shift()({ branch: [...window.branch] }));
    await page.getByText('队列用户-' + behavior, { exact: true }).waitFor();
    await page.evaluate(behavior => window.rpc({ type: 'tool_execution_end', toolCallId: 'queue-old-' + behavior, toolName: 'read', result: { content: '保留队列前工具-' + behavior } }), behavior);
    await page.waitForTimeout(200);
    assert(await lastIsUser(), 'old orphan tool stays before consumed ' + behavior + ' user');
    assert(await page.evaluate(behavior => window.store.getState().toolProgress.mock.some(t => t.text === '保留队列前工具-' + behavior), behavior), 'old tool remains in store');
    await page.screenshot({ path: `output/playwright/late-stream-queue-${behavior}.png` });
  }
  assert(errors.length === 0, errors.join('\n'));
  console.log('PASS: real store + ChatView, four sends, overlapping identified streams, snapshot+delta metadata, queued followUp/steer, slow history, DOM order and scroll screenshots');
}
