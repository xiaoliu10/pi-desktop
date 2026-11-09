// 子代理「省略思考」按需展开：默认折叠态与现状一致；点开才拉真实内容（合成组件测试）。
// playwright-cli -s=thinking-expand run-code --filename tests/subagent-thinking-expand.browser.cjs
// harness: npx vite --host 127.0.0.1 --port 5191 --strictPort（跑完 kill）
// 注：先以 running 状态渲染（adapter store 初始化会瞬时把 selectedKey 置 null，
// running 的 3s 轮询能自愈；completed 一次性拉取撞上该窗口会永久停在读取态），
// 内容出现后切 completed 停轮询再做交互断言（与 subagent-live-transcript 同策略）。
async (page) => {
  const assert = (ok, label) => { if (!ok) throw new Error(label); };
  const errors = []; page.on('pageerror', error => errors.push(String(error)));
  await page.setViewportSize({ width: 900, height: 720 });
  await page.route('http://127.0.0.1:5191/thinking-expand', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script>' }));
  await page.goto('http://127.0.0.1:5191/thinking-expand');
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    const { SubagentPanel } = await import('/pi/SubagentPanel.tsx');
    const { usePiStore } = await import('/pi/adapter.ts');
    usePiStore.setState({ lang: 'zh', selectedKey: 'a'.repeat(64) });
    window.__thinkCalls = [];
    window.localPi = {
      subagentChildTranscript: async () => ({ messages: [
        { id: 'e-t', role: 'assistant', content: [
          { type: 'thinking', thinking: '[子代理详情省略思考内容]' },
          { type: 'text', text: 'FINDING TEXT' },
        ] },
      ], truncated: false }),
      subagentChildThinking: async (key, callId, childId, entryId, blockIndex) => {
        window.__thinkCalls.push({ key, callId, childId, entryId, blockIndex });
        return { thinking: 'REAL THINKING CONTENT', truncated: false };
      },
    };
    const root = createRoot(document.getElementById('root'));
    window.__render = (status) => root.render(React.createElement('main', { className: 'pireplica' }, React.createElement(SubagentPanel, {
      children: [{ id: 'c1', callId: 'call-th', childKey: 'single', agent: 'code-reviewer', task: 'thinking fixture', mode: 'single', status, messages: [] }],
      initialCall: 'call-th', parentRunning: status === 'running', onClose() {}, onStop() {},
    })));
    window.__render('running');
  });

  // running 轮询拿到转录后切 completed：停轮询，稳定态下做交互断言
  await page.getByText('FINDING TEXT', { exact: true }).waitFor({ timeout: 15000 });
  await page.evaluate(() => window.__render('completed'));
  await page.waitForTimeout(300);

  // 默认折叠：完成态执行组先点开，组内思考块必须仍是折叠的 details（与现状一致）
  const group = page.locator('.pi-subagents__transcript .pi-execution').first();
  await group.waitFor({ state: 'visible', timeout: 8000 });
  if (await group.getAttribute('open') === null) await group.locator(':scope > summary').click();
  const note = group.locator('.pi-execution__note').first();
  await note.waitFor({ state: 'visible', timeout: 8000 });
  assert(await note.evaluate(el => el.open === false), 'thinking block collapsed by default');
  assert(await page.locator('.pi-execution__note-body').count() === 0, 'no body rendered while collapsed');

  // 点开：触发一次按需拉取并展示真实内容
  await note.locator(':scope > summary').click();
  await page.getByText('REAL THINKING CONTENT', { exact: true }).waitFor({ timeout: 8000 });
  const calls = await page.evaluate(() => window.__thinkCalls);
  assert(calls.length === 1, 'thinking fetched exactly once on expand');
  assert(calls[0].entryId === 'e-t' && calls[0].blockIndex === 0, `fetch addressed the right entry/block: ${JSON.stringify(calls[0])}`);
  assert(calls[0].key === 'a'.repeat(64) && calls[0].callId === 'call-th' && calls[0].childId === 'single', 'fetch carries session/child identity');
  // 占位文案不得残留在展开正文里
  assert(!(await page.locator('.pi-execution__note-body').innerText()).includes('[子代理详情省略思考内容]'), 'placeholder replaced by real content');

  // 收起再展开：不重复请求（结果已缓存）
  await note.locator(':scope > summary').click();
  await note.locator(':scope > summary').click();
  await page.getByText('REAL THINKING CONTENT', { exact: true }).waitFor({ timeout: 5000 });
  assert((await page.evaluate(() => window.__thinkCalls)).length === 1, 'reopen reuses cached content');

  await page.screenshot({ path: 'output/playwright/subagent-thinking-expand.png' });
  assert(errors.length === 0, errors.join('\n'));
  return 'PASS default collapsed + click-to-load thinking + cached reopen';
}
