// Synthetic component mock; Vite on 127.0.0.1:5175.
// playwright-cli -s=subagent-activity run-code --filename tests/subagent-activity.browser.cjs
async (page) => {
  const assert = (ok, label) => { if (!ok) throw new Error(label); };
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.setViewportSize({ width: 900, height: 720 });
  await page.route('http://127.0.0.1:5175/subagent-test', route => route.fulfill({ contentType: 'text/html', body: '<html><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script></body></html>' }));
  await page.goto('http://127.0.0.1:5175/subagent-test');
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    const { SubagentPanel } = await import('/pi/SubagentPanel.tsx');
    const { usePiStore } = await import('/pi/adapter.ts');
    await import('/replica/tokens.css'); await import('/replica/chat/chat.css');
    usePiStore.setState({ lang: 'zh' });
    const style = document.createElement('style'); style.textContent = 'body{margin:0}.pireplica{height:100vh;background:var(--pi-bg);color:var(--pi-text)}'; document.head.appendChild(style);
    const root = createRoot(document.getElementById('root'));
    window.renderChild = (status, kind, theme = 'light') => {
      const messages = kind === 'none' ? [] : [{ role: 'assistant', content: kind === 'steps' ? [{ type: 'thinking', thinking: '正在检查模拟任务' }, { type: 'toolCall', id: 'tool', name: 'bash', arguments: { command: 'echo mock' } }] : [{ type: 'text', text: '旧历史回复，仅用于验证状态不依赖文本。\n\n'.repeat(kind === 'long' ? 80 : 1) }], stopReason: 'stop' }];
      root.render(React.createElement('main', { className: 'pireplica', 'data-theme': theme }, React.createElement(SubagentPanel, { key: kind, children: [{ id: 'child-' + kind, callId: 'call', agent: 'mock tester', task: '验证子代理活动提示', mode: 'single', status, messages }], initialCall: 'call', parentRunning: false, onClose() {}, onStop() {} })));
    };
    window.renderChild('running', 'none');
  });
  const working = page.locator('.pi-subagents__working');
  for (const theme of ['light', 'dark']) {
    for (const state of ['running', 'queued']) for (const kind of ['none', 'text', 'steps', 'long']) {
      await page.evaluate(([s, k, t]) => window.renderChild(s, k, t), [state, kind, theme]);
      await working.waitFor({ state: 'visible' });
      assert(await working.innerText().then(t => t.includes('正在工作')), 'working text');
      assert(await page.locator('.pi-subagents__transcript .pi-spinner:visible').count() === 1, 'one visible transcript spinner');
      const box = await working.boundingBox(); assert(box && box.y >= 0 && box.y + box.height <= 720, 'bottom activity visible');
      assert(await working.locator('.pi-spinner').evaluate(el => getComputedStyle(el).animationName !== 'none'), 'animated chrysanthemum');
      if (state === 'running' && kind !== 'long') await page.screenshot({ path: `output/playwright/subagent-${theme}-${kind}.png` });
    }
    for (const state of ['completed', 'failed', 'interrupted', 'skipped', 'unknown', 'recovered']) {
      await page.evaluate(([s, t]) => window.renderChild(s, 'steps', t), [state, theme]);
      await working.waitFor({ state: 'detached' });
      assert(await page.locator('.pi-subagents__transcript .pi-spinner:visible').count() === 0, state + ' stopped');
      const group = page.locator('.pi-execution'); if (await group.getAttribute('open') === null) await group.locator(':scope > summary').click();
      assert(await group.getAttribute('open') !== null, 'terminal process remains expandable');
      if (state === 'completed') await page.screenshot({ path: `output/playwright/subagent-${theme}-completed.png` });
    }
  }
  assert(errors.length === 0, errors.join('\n'));
  console.log('PASS: light/dark, running/queued with no output, old text, steps and long history; one animated bottom spinner; six inactive states stop; terminal expand interaction');
}
