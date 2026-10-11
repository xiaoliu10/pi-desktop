// 辅助对话面板绑定启动顺序：
// 1) 存储的绑定可能是陈旧 key（文件被外部删过、ensure 会修复重建），面板必须等 ensure
//    返回后才发布 key —— 绝不能对陈旧 key 先 history（0.1.16 面板首开「会话不存在」根因之一）。
// 2) 历史读取失败显示真实错误，恢复后清除，且不清空其它域的错误状态。
// Vite at :5175 (bind 127.0.0.1 — dev default ::1 refuses these requests):
//   npx vite --port 5175 --host 127.0.0.1
// playwright-cli -s sidecar open about:blank; run-code --filename tests/sidecar-panel-stale-binding.browser.cjs
async (page) => {
  const assert = (ok, label) => { if (!ok) throw new Error(label); };
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.setViewportSize({ width: 900, height: 700 });
  await page.route('http://127.0.0.1:5175/sidecar-stale', route => route.fulfill({ contentType: 'text/html', body: '<html><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script></body></html>' }));
  await page.goto('http://127.0.0.1:5175/sidecar-stale');
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    window.__errs = [];
    window.addEventListener('error', e => window.__errs.push(String(e.message).slice(0, 400)));
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    const { SidecarPanel } = await import('/pi/SidecarPanel.tsx');
    const historyCalls = []; let failHistory = true; let notify;
    window.localPi = {
      // 存储绑定指向已失效的旧 key：ensure 会修复并返回 fresh-key。
      sidecarBinding: async () => 'stale-key',
      // Delay emulates the real repair (pi subprocess relaunch): the stale render must
      // commit before ensure resolves, otherwise React batches both keys into one render.
      sidecarEnsure: async () => { await new Promise(r => setTimeout(r, 250)); return { key: 'fresh-key', run: { key: 'fresh-key', generation: 'g2', cwd: '/w', file: '/w/fresh.jsonl', status: 'idle', accessMode: 'ask', models: [], commands: [], pending: 0 } }; },
      history: async key => {
        historyCalls.push(key);
        if (failHistory) throw new Error('历史暂不可读（测试注入）');
        return { session: {}, entries: [], branch: [], leaves: [], leafId: null, syncedAt: 1 };
      },
      onEvent: cb => { notify = cb; return () => {}; },
      prompt: async () => ({}), stop: async () => ({ steering: [], followUp: [] }), respond: async () => ({}),
    };
    window.__emit = () => notify && notify({ type: 'sessions-changed' });
    window.__calls = historyCalls;
    window.__setHistoryOk = () => { failHistory = false; };
    createRoot(document.getElementById('root')).render(React.createElement(SidecarPanel, { mainKey: 'main-1', autoStart: true, onClose: () => {} }));
  });
  // ensure 返回后 key 才发布，且发布的是修复后的 fresh-key
  await page.waitForFunction(() => document.querySelector('[data-sidecar-key]')?.getAttribute('data-sidecar-key') === 'fresh-key', undefined, { timeout: 5000 });
  let calls = await page.evaluate(() => window.__calls);
  assert(!calls.includes('stale-key'), 'stale binding key must never be passed to history');
  assert(calls[0] === 'fresh-key', 'history loads the ensure-returned key first: ' + JSON.stringify(calls));
  // 历史读取失败：显示真实错误，不吞成空历史
  await page.locator('.pi-sidecar__error', { hasText: '历史暂不可读' }).waitFor({ timeout: 5000 });
  // 历史恢复后错误清除（事件触发的重读成功）
  await page.evaluate(() => { window.__setHistoryOk(); window.__emit(); });
  await page.waitForFunction(() => !document.querySelector('.pi-sidecar__error'), undefined, { timeout: 5000 });
  calls = await page.evaluate(() => window.__calls);
  assert(calls.every(k => k === 'fresh-key'), 'reloads keep using the repaired key: ' + JSON.stringify(calls));
  assert(errors.length === 0 && (await page.evaluate(() => window.__errs)).length === 0, 'no page errors: ' + errors.concat(await page.evaluate(() => window.__errs)).join(' | '));
  await page.screenshot({ path: 'output/playwright/sidecar-panel-stale-binding.png' });
  return 'PASS sidecar-panel-stale-binding: ensure-repaired key published (stale key never loaded); history failure shown then cleared on recovery';
}
