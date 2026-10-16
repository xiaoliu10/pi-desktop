// 实机验证主对话「运行中子代理」提示条：有 live 子代理时渲染、可点击打开面板、
// 全部结束后消失。与 store 单测互补——这里验证真实 React 渲染与交互。
// Run: playwright-cli -s=subagent-bar run-code "$(< tests/subagent-bar.browser.cjs)"
async (page) => {
  const errors = [];
  const assert = (ok, message) => { if (!ok) throw Error(message); };
  const text = async locator => (await locator.count() ? await locator.innerText() : '');
  page.on('pageerror', error => errors.push(String(error)));
  const url = 'http://127.0.0.1:5175/subagent-bar-harness';
  await page.route(url, route => route.fulfill({ contentType: 'text/html', body: '<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.__vite_plugin_react_preamble_installed__=true;</script>' }));
  await page.goto(url);
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    const { RunningSubagentBar } = await import('/pi/RunningSubagentBar.tsx');
    await import('/styles.css');
    await import('/replica/tokens.css');
    window.__children = [];
    window.__openCount = 0;
    window.__render = children => {
      window.__children = children;
      (window.__root ??= createRoot(document.getElementById('root')))
        .render(React.createElement(RunningSubagentBar, { subagents: children, onOpen: () => { window.__openCount += 1; } }));
    };
  });

  const bar = page.locator('.pi-subagent-bar');
  // 1) 无子代理 → 不渲染（不留空壳占位）
  assert(await bar.count() === 0, 'bar hidden without subagents');

  // 2) 有 running/queued → 渲染，文案含数量与 agent 名，role=status 对辅助技术可见
  await page.evaluate(() => window.__render([
    { id: 'c1', callId: 'call-1', agent: 'code-reviewer', task: '审查 diff', mode: 'workflow', status: 'running', messages: [] },
    { id: 'c2', callId: 'call-1', agent: 'test-automator', task: '补测试', mode: 'workflow', status: 'queued', messages: [] },
    { id: 'c3', callId: 'call-2', agent: 'electron-pro', task: '旧任务', mode: 'single', status: 'completed', messages: [] },
  ]));
  await page.waitForTimeout(250);
  assert(await bar.count() === 1, 'bar shown while a subagent is live');
  assert(await bar.getAttribute('role') === 'status', 'bar is an aria-live status region');
  const shown = await text(bar);
  assert(shown.includes('2'), 'live count includes running + queued');
  assert(shown.includes('code-reviewer') && shown.includes('test-automator'), 'live agent names listed');
  assert(!shown.includes('electron-pro'), 'ended subagents are not announced as working');

  // 3) 点击 → 打开子代理面板（与右侧详情面板同一入口）
  await page.locator('.pi-subagent-bar__action').click();
  assert(await page.evaluate(() => window.__openCount) === 1, 'click opens the subagent panel');

  // 4) 全部结束 → 提示条消失（React 异步提交，等一帧）
  await page.evaluate(() => window.__render([
    { id: 'c1', callId: 'call-1', agent: 'code-reviewer', task: '审查 diff', mode: 'workflow', status: 'completed', messages: [] },
    { id: 'c2', callId: 'call-1', agent: 'test-automator', task: '补测试', mode: 'workflow', status: 'completed', messages: [] },
  ]));
  await page.waitForTimeout(250);
  assert(await bar.count() === 0, 'bar disappears once every subagent settled');

  if (errors.length) throw new Error('page errors: ' + errors.join(' | '));
}
