// With the existing Vite preview on 5175:
// playwright-cli -s=board-order run-code "$(< tests/subagent-order.browser.cjs)"
async (page) => {
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  const url = 'http://127.0.0.1:5175/board-order-harness';
  await page.route(url, route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script>' }));
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.goto(url);
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    await import('/styles.css'); await import('/replica/tokens.css');
    const { ConversationStatusPanel } = await import('/pi/ConversationStatusPanel.tsx');
    localStorage.removeItem('pi-status-collapsed');
    const statuses = ['failed', 'queued', 'completed', 'running', 'unknown', 'queued', 'interrupted', 'running', 'recovered', 'skipped'];
    // Keep the array identity across rerenders to catch stale memoization, and
    // freeze its ordering to catch accidental in-place sorting.
    window.orderChildren = Object.freeze(statuses.map((status, i) => ({ id: `child-${i}`, callId: `call-${i}`, status, agent: `agent-${i}`, task: `${status} task ${i}`, mode: 'single', messages: [] })));
    window.opened = []; window.removed = []; window.cleared = [];
    function Fixture() {
      const [, render] = React.useState(0);
      window.orderUpdate = (index, patch) => { Object.assign(window.orderChildren[index], patch); render(n => n + 1); };
      return React.createElement('main', { className: 'pireplica', style: { padding: 24 } }, React.createElement(ConversationStatusPanel, {
        messages: [], running: false, subagents: window.orderChildren, onReview() {}, onRequest() {},
        onOpenSubagent: id => window.opened.push(id), onDismissSubagent: id => window.removed.push(id), onDismissFinishedSubagents: ids => window.cleared.push(ids),
      }));
    }
    createRoot(document.getElementById('root')).render(React.createElement(Fixture));
  });
  await page.locator('.pi-status-agent-row').first().waitFor();
  let checks = 0;
  const assert = (ok, message) => { if (!ok) throw Error(message); checks++; };
  const order = () => page.locator('.pi-status-agent[data-call-id]').evaluateAll(rows => rows.map(row => row.dataset.callId));
  const expected = ids => ids.map(i => `call-${i}`);
  const checkOrder = async ids => {
    await page.waitForFunction(ids => JSON.stringify([...document.querySelectorAll('.pi-status-agent[data-call-id]')].map(el => el.dataset.callId)) === JSON.stringify(ids), expected(ids));
    assert(JSON.stringify(await order()) === JSON.stringify(expected(ids)), `visible order ${ids}`);
  };
  const row = i => page.locator(`.pi-status-agent-row:has([data-call-id="call-${i}"])`);
  await checkOrder([3, 7, 1, 5, 0, 2, 4, 6, 8, 9]);
  assert(await page.getByText('4 运行 · 6 已结束', { exact: true }).count() === 1, 'counts unaffected by sort');
  assert(await page.locator('.pi-status-agent-remove').count() === 6, 'only ended rows removable');
  await row(7).locator('.pi-status-agent').click();
  await row(0).locator('.pi-status-agent-remove').click();
  assert(JSON.stringify(await page.evaluate(() => opened)) === '["call-7"]', 'moved detail row targets original callId');
  assert(JSON.stringify(await page.evaluate(() => removed)) === '["call-0"]', 'moved delete row targets original callId without opening detail');
  await page.evaluate(() => orderUpdate(7, { tokens: 100000, messages: [{ role: 'assistant', content: 'progress' }] }));
  await checkOrder([3, 7, 1, 5, 0, 2, 4, 6, 8, 9]);
  await page.evaluate(() => orderUpdate(3, { status: 'completed' }));
  await checkOrder([7, 1, 5, 0, 2, 3, 4, 6, 8, 9]);
  assert(await page.getByText('3 运行 · 7 已结束', { exact: true }).count() === 1, 'completion updates counts');
  assert(await row(3).locator('.pi-status-agent-remove').count() === 1, 'newly completed row now removable');
  await page.evaluate(() => orderUpdate(1, { status: 'running' }));
  await checkOrder([1, 7, 5, 0, 2, 3, 4, 6, 8, 9]);
  assert(await row(1).locator('.pi-status-agent-remove').count() === 0 && await row(5).locator('.pi-status-agent-remove').count() === 0, 'running and queued remain protected');
  await row(3).locator('.pi-status-agent').click();
  await row(3).locator('.pi-status-agent-remove').click();
  assert(JSON.stringify(await page.evaluate(() => opened)) === '["call-7","call-3"]', 'completed moved detail retains callId');
  assert(JSON.stringify(await page.evaluate(() => removed)) === '["call-0","call-3"]', 'completed moved delete retains callId');
  await page.getByRole('button', { name: '清空已结束的子代理记录' }).click();
  assert(JSON.stringify(await page.evaluate(() => cleared)) === JSON.stringify([expected([0, 2, 3, 4, 6, 8, 9])]), 'bulk targets ended original callIds in source order');
  assert(JSON.stringify(await page.evaluate(() => orderChildren.map(c => c.callId))) === JSON.stringify(expected([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])), 'source array order never mutated');
  await page.locator('.pi-status-rail').screenshot({ path: 'output/playwright/subagent-order.png' });
  assert(errors.length === 0, errors.join('\n'));
  return { checks, errors, order: await order() };
}
