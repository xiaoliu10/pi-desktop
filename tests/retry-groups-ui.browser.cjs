async (page) => {
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  const url = 'http://127.0.0.1:5175/retry-groups-harness';
  await page.route(url, route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script>' }));
  await page.goto(url);
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    const { ChatView } = await import('/replica/chat/ChatView.tsx');
    const { usePiStore } = await import('/pi/adapter.ts');
    const { replicaLabels } = await import('/replica/i18n.ts');
    await import('/styles.css'); await import('/replica/tokens.css');
    const run = { key: 'group-browser', generation: 'g', cwd: '/mock', file: '/mock/a', status: 'running', models: [], commands: [], pending: 0 };
    window.stopCalls = []; window.historyCalls = 0;
    window.localPi = {
      onEvent: cb => { window.emitRetry = cb; },
      settingsSnapshot: async () => { throw Error('fixture'); }, environment: async () => { throw Error('fixture'); },
      sessions: async () => [], runs: async () => [], archivedSessions: async () => [],
      history: async () => { window.historyCalls++; return { branch: [], entries: [], leaves: [] }; },
      stop: async key => { window.stopCalls.push(key); return { steering: [], followUp: [] }; },
    };
    usePiStore.getState().init();
    await Promise.resolve(); await Promise.resolve();
    usePiStore.setState({ selectedKey: run.key, runs: [run], retrying: {}, sends: [], live: {}, toolProgress: {}, history: { branch: [] }, notifications: [] });
    const messages = [{ id: 'u', role: 'user', parts: [{ kind: 'text', id: 'ut', text: '隔离重试组验证' }] }, { id: 'e', role: 'assistant', modelOutcome: 'error', parts: [{ kind: 'error', source: 'model', id: 'err', message: 'fetch failed', details: 'original interrupted details' }] }];
    let recovered = false;
    window.groupState = (phase, group = 2, inner = false, nextRetryAt) => {
      recovered = phase === 'completed';
      const retryGroup = { group, maxGroups: 10, phase, nextRetryAt };
      window.emitRetry({ type: 'run', run: { ...run, status: ['waiting', 'running'].includes(phase) ? 'running' : 'idle', retryGroup } });
      if (inner) window.rpcRetry({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 0, errorMessage: 'fetch failed' });
    };
    window.rpcRetry = event => window.emitRetry({ type: 'rpc', key: run.key, generation: 'g', event });
    window.getRetryRun = () => usePiStore.getState().runs[0];
    function Harness() {
      const s = usePiStore(); const r = s.runs[0];
      return React.createElement('main', { className: 'pireplica', style: { height: '100vh' } }, React.createElement(ChatView, {
        messages: recovered ? [...messages, { id: 'ok', role: 'assistant', modelOutcome: 'success', parts: [{ kind: 'text', id: 'okt', text: '恢复成功' }] }] : messages,
        running: r?.status === 'running', queued: 0, demo: false, labels: replicaLabels('zh').chat, onJumpToMessage: () => {},
        retryGroup: r?.retryGroup, retrying: s.retrying[run.key], onStop: s.stop, stopping: r?.status === 'stopping',
      }));
    }
    createRoot(document.getElementById('root')).render(React.createElement(Harness));
  });
  let checks = 0;
  const assert = (value, message) => { if (!value) throw Error(message); checks++; };
  const set = async (...args) => { await page.evaluate(args => window.groupState(...args), args); await page.waitForTimeout(60); };
  await set('running', 1);
  assert(await page.locator('.pi-chat__retry').count() === 0, 'normal group 1 not cluttered');
  await set('running', 2, true);
  assert((await page.locator('.pi-chat__retry').innerText()).includes('第 2/10 组'), 'Desktop count');
  assert((await page.locator('.pi-chat__retry').innerText()).includes('第 1/3 次'), 'CLI count');
  assert(await page.locator('.pi-error-card').count() === 0, 'retry hides model errors');
  await page.evaluate(() => window.rpcRetry({ type: 'auto_retry_end', success: false }));
  await page.waitForTimeout(60);
  assert(await page.locator('.pi-error-card').count() === 0, 'end/start gap hides model errors');
  await set('waiting', 2, false, Date.now() + 3000);
  assert((await page.locator('.pi-chat__retry').innerText()).includes('秒后开始下一组'), 'host countdown');
  const before = await page.evaluate(() => window.historyCalls);
  await page.evaluate(() => window.rpcRetry({ type: 'desktop_retry_group_wait' }));
  await page.waitForTimeout(500);
  assert(await page.evaluate(() => window.historyCalls) > before, 'wait refreshes history');
  assert((await page.evaluate(() => window.getRetryRun())).status === 'running', 'wait never idles task');
  await page.waitForTimeout(2700);
  assert((await page.locator('.pi-chat__retry').innerText()).includes('等待下一组开始'), 'expired countdown waits for host');
  assert((await page.evaluate(() => window.getRetryRun())).retryGroup.group === 2, 'deadline never increments group');
  for (const phase of ['waiting', 'running']) {
    await set(phase, 4);
    await page.getByRole('button', { name: '取消任务', exact: true }).click();
    assert(await page.getByRole('button', { name: '取消任务', exact: true }).isDisabled(), 'stop pending disabled');
    const r = await page.evaluate(() => window.getRetryRun());
    assert(r.status === 'stopping' && r.retryGroup.phase === phase && r.retryGroup.group === 4, 'stop preserves host state');
  }
  assert((await page.evaluate(() => window.stopCalls)).join(',') === 'group-browser,group-browser', 'existing stop called for both phases');
  await set('cancelled', 4);
  // 任务终态（取消/完成）横幅必须退场，残留会被读成仍在重试（用户反馈）。
  assert(await page.locator('.pi-chat__retry').count() === 0, 'cancelled retires banner');
  await set('exhausted', 10);
  assert((await page.locator('.pi-chat__retry').innerText()).includes('第 10/10 组'), 'group10 exhaustion');
  await page.getByText('查看错误详情', { exact: true }).click();
  assert(await page.getByText('original interrupted details', { exact: true }).isVisible(), 'failure details preserved');
  await set('completed', 5);
  assert(await page.locator('.pi-error-card').count() === 0, 'success hides historical model error');
  assert(await page.locator('.pi-chat__retry').count() === 0, 'completed retires banner, no lingering retry chrome');
  assert(errors.length === 0, errors.join('\n'));
  await page.screenshot({ path: 'output/playwright/retry-groups-completed.png' });
  return { checks, errors };
}
