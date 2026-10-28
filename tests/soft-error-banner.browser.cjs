// 真实浏览器回归：错误呈现从「大红横幅 + 必须手点」改为「输入框上方小横幅 + 自动消失」。
// 跑法：npx vite --host 127.0.0.1 --port 5175 --strictPort（本 worktree）+
//   playwright-cli -s=chatlink run-code --filename tests/soft-error-banner.browser.cjs
async (page) => {
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.setViewportSize({ width: 1180, height: 860 });
  const url = 'http://127.0.0.1:5175/soft-error-harness';
  await page.route(url, route => route.fulfill({ contentType: 'text/html', body: '<div id="root" class="pireplica"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script>' }));
  await page.goto(url);
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)/)[1])).default;
    await import('/styles.css'); await import('/replica/tokens.css');
    await import('/pi/replica-app.css'); await import('/replica/chat/chat.css');
    const { usePiStore, sentConversationMessages } = await import('/pi/adapter.ts');
    const { ChatView } = await import('/replica/chat/ChatView.tsx');
    const { replicaLabels } = await import('/replica/i18n.ts');
    window.store = usePiStore;
    window.branch = [{ id: 'u-0', type: 'message', message: { role: 'user', content: '上一轮' } }];
    let emit = null;
    window.localPi = {
      onEvent: (fn) => { emit = fn; },
      prompt: () => Promise.resolve('handled'),
      history: () => Promise.resolve({ branch: [...window.branch] }),
      runs: () => Promise.resolve([]), sessions: () => Promise.resolve([]), archivedSessions: () => Promise.resolve([]), recoverSubagents: () => Promise.resolve({ unchanged: true }),
      settingsSnapshot: () => Promise.reject('mock'), environment: () => Promise.reject('mock'),
    };
    window.emitRpc = (event) => { if (typeof emit !== 'function') throw new Error('onEvent 未注册'); emit({ type: 'rpc', key: 'mock', generation: 'g', event }); };
    usePiStore.setState({ selectedKey: 'mock', runs: [{ key: 'mock', status: 'idle', generation: 'g', pending: 0 }], history: { branch: window.branch }, sends: [], connecting: false, draftText: '', contextItems: [], live: {}, toolProgress: {}, pendingSteer: {}, error: undefined, errorKey: undefined, view: 'chat' });
    usePiStore.getState().init();
    await new Promise(r => setTimeout(r, 0));
    function App() {
      const s = usePiStore();
      return React.createElement('main', { className: 'pireplica', style: { height: '100vh', display: 'flex', flexDirection: 'column' } },
        React.createElement('div', { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } },
          s.error && (!s.errorKey || s.errorKey === s.selectedKey) && React.createElement('div', { className: 'pi-banner pi-banner--error', role: 'alert' },
            React.createElement('span', null, s.error),
            React.createElement('button', { 'aria-label': '关闭错误', onClick: () => s.dismissError() }, '×')),
          React.createElement('div', { style: { marginTop: 'auto' } },
            React.createElement(ChatView, {
              messages: sentConversationMessages(s.history?.branch || [], s.live.mock, s.toolProgress.mock, s.sends || []),
              scrollRequest: undefined, sending: false, labels: replicaLabels('zh').chat, demo: false,
            }))));
    }
    createRoot(document.getElementById('root')).render(React.createElement(App));
  });
  const assert = (ok, label) => { if (!ok) throw new Error(label); };
  // 1) 写入错误 → 小横幅出现
  await page.evaluate(() => window.store.setState({ error: '模型调用失败：上游 502', errorKey: 'mock' }));
  const banner = page.locator('.pi-banner--error');
  await banner.waitFor({ timeout: 8000 });
  assert(await banner.count() === 1, '小横幅应只出现一次');
  const style = await banner.evaluate(el => { const cs = getComputedStyle(el); const r = el.getBoundingClientRect(); return { padding: cs.paddingTop, fontSize: cs.fontSize, bg: cs.backgroundColor, height: r.height }; });
  assert(parseFloat(style.fontSize) <= 13, `字号应 ≤13px（小横幅）：${style.fontSize}`);
  assert(parseFloat(style.padding) <= 8, `内边距应紧凑：${style.padding}`);
  assert(style.height < 40, `高度应小：${style.height}`);
  // 2) 位置：必须在输入框上方（composer 之前）
  const composerTop = await page.evaluate(() => { const c = document.querySelector('.pi-composer') || document.querySelector('.pi-chat'); return c ? c.getBoundingClientRect().top : 1e9; });
  const bannerBottom = await banner.evaluate(el => el.getBoundingClientRect().bottom);
  assert(bannerBottom <= composerTop + 1, `小横幅应在输入框上方（banner.bottom=${bannerBottom} composer.top=${composerTop}）`);
  await page.screenshot({ path: 'output/playwright/soft-error-banner.png' });
  // 3) 自动消失：agent_start 后不清手点
  await page.evaluate(() => window.emitRpc({ type: 'agent_start' }));
  await page.waitForFunction(() => document.querySelectorAll('.pi-banner--error').length === 0, { timeout: 5000 });
  assert(await page.locator('.pi-banner--error').count() === 0, 'agent_start 后应自动消失');
  // 4) 手点关闭兜底仍可用
  await page.evaluate(() => window.store.setState({ error: '另一处失败', errorKey: 'mock' }));
  await banner.waitFor({ timeout: 5000 });
  await page.locator('.pi-banner--error button').click();
  await page.waitForFunction(() => document.querySelectorAll('.pi-banner--error').length === 0, { timeout: 5000 });
  assert(await page.locator('.pi-banner--error').count() === 0, '手点关闭兜底可用');
  assert(errors.length === 0, 'browser errors: ' + errors.join('\n'));
  console.log('PASS: 错误改为输入框上方小横幅，agent_start 自动消失，手点关闭兜底保留');
  return {};
}
