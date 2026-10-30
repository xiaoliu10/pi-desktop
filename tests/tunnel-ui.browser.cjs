// 远程隧道卡（R-remote-02）UI 回归：TunnelCard 渲染、状态徽标、保存时把
// relay 地址 + key 传给 tunnelSave、关闭隧道调 enabled:false、hasKey 时 key 可留空。
// Vite at :5175; playwright-cli -s tunnelui open about:blank; run-code --filename tests/tunnel-ui.browser.cjs
async (page) => {
  const assert = (ok, label) => { if (!ok) throw new Error(label); };
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.route('http://localhost:5175/tunnel-ui', route => route.fulfill({ contentType: 'text/html', body: '<html><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script></body></html>' }));
  await page.goto('http://localhost:5175/tunnel-ui');
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.reload(); // 可重复跑：清掉上一次的 DOM/内存态
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"]*)"/)[1])).default;
    const { RemotePane } = await import('/pi/RemotePane.tsx');
    await import('/replica/tokens.css'); await import('/pi/replica-app.css');
    window.__tunnel = { saves: [], status: { enabled: false, state: 'stopped' } };
    window.localPi = {
      remoteStatus: async () => ({ running: false, urls: [], viewers: 0 }),
      imConfig: async () => ({ provider: 'off', notifyCompleted: false, notifyError: false }),
      tunnelGet: async () => ({ enabled: false, relayUrl: '', deviceName: '', hasKey: false }),
      tunnelSave: async (patch) => { window.__tunnel.saves.push(patch); return { enabled: patch.enabled ?? false, relayUrl: patch.relayUrl ?? '', deviceName: '', hasKey: true }; },
      tunnelStatus: async () => window.__tunnel.status,
    };
    const root = createRoot(document.getElementById('root'));
    root.render(React.createElement('main', { style: { padding: 20 } }, React.createElement(RemotePane)));
  });
  const card = page.locator('.pi-remote__botcard', { hasText: '公网隧道' });
  await card.waitFor();

  // 1) 未配置态：启用按钮 disabled（无地址无 key）
  const enableBtn = card.locator('button', { hasText: '启用隧道' });
  assert(await enableBtn.isDisabled(), 'enable button disabled without address/key');

  // 2) 填地址+key → 启用：tunnelSave 收到 relayUrl+key+enabled:true
  await card.locator('input:not([type=password])').fill('https://relay.example.com:8443');
  await card.locator('input[type=password]').fill('secret-key');
  await enableBtn.click();
  await page.waitForTimeout(150);
  const save0 = await page.evaluate(() => window.__tunnel.saves[0]);
  assert(save0 && save0.relayUrl === 'https://relay.example.com:8443' && save0.key === 'secret-key' && save0.enabled === true,
    `first save carries url+key+enabled, got ${JSON.stringify(save0)}`);

  // 3) key 输入框保存后被清空（明文不残留）
  const kv = await card.locator('input[type=password]').inputValue();
  assert(kv === '', `key input cleared after save, got "${kv}"`);

  // 4) 已设置 hasKey → 「保存配置」不填 key，不会碰已存 key（key 字段 undefined）
  await page.evaluate(() => { window.__tunnel.saves.length = 0; });
  await card.locator('input:not([type=password])').fill('https://relay2.example.com:8443');
  const saveBtn = card.locator('button', { hasText: '保存配置' });
  await saveBtn.click();
  await page.waitForTimeout(150);
  const save1 = await page.evaluate(() => window.__tunnel.saves[0]);
  assert(save1 && save1.relayUrl === 'https://relay2.example.com:8443' && save1.key === undefined,
    `save without key leaves stored key untouched, got ${JSON.stringify(save1)}`);

  // 5) 状态徽标随 tunnelStatus 变化（paired → 「终端已接入」）
  await page.evaluate(() => { window.__tunnel.status = { enabled: true, state: 'paired' }; });
  await page.waitForTimeout(3300); // 等 3s 轮询
  const pillText = await card.locator('.pi-remote__pill-text').allTextContents();
  assert(pillText.some(t => t.includes('终端已接入')), `status pill shows paired, got ${JSON.stringify(pillText)}`);

  // 6) 启用 → 变「关闭隧道」→ 点击 → enabled:false（开关闭环）
  await card.locator('button', { hasText: '启用隧道' }).click();
  await page.waitForTimeout(150);
  const disableBtn = card.locator('button', { hasText: '关闭隧道' });
  await disableBtn.waitFor();
  await disableBtn.click();
  await page.waitForTimeout(150);
  const saves = await page.evaluate(() => window.__tunnel.saves);
  assert(saves.some(s => s.enabled === true) && saves[saves.length - 1]?.enabled === false,
    `enable→disable cycle sends enabled true then false, got ${JSON.stringify(saves)}`);

  assert(errors.length === 0, `no page errors: ${errors.join(' | ')}`);
}
