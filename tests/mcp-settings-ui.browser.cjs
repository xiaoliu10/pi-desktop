// 设置页 MCP 行：导入服务（source）与直连服务都必须有 启用/禁用 开关；导入服务不显示移除。
// 之前导入服务无开关，用户无法关闭不需要的 MCP（用户反馈）。Vite at :5175;
// playwright-cli -s mcpui open about:blank; run-code --filename tests/mcp-settings-ui.browser.cjs
async (page) => {
  const assert = (ok, label) => { if (!ok) throw new Error(label); };
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.setViewportSize({ width: 980, height: 780 });
  await page.route('http://127.0.0.1:5175/mcp-settings', route => route.fulfill({ contentType: 'text/html', body: '<html><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script></body></html>' }));
  await page.goto('http://127.0.0.1:5175/mcp-settings');
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    const { SettingsFeatures } = await import('/pi/SettingsFeatures.tsx');
    await import('/replica/tokens.css'); await import('/pi/settings-features.css'); await import('/pi/replica-app.css');
    const row = (name, extra) => ({ id: `id-${name}`, name, scope: 'user', transport: 'stdio', target: name, enabled: true, path: '/tmp/mcp.json', revision: 'rev', ...extra });
    const calls = [];
    window.localPi = {
      settingsSnapshot: async () => ({
        preferences: {}, ai: { defaultProvider: '', defaultModel: '', defaultThinkingLevel: 'off', autoCompact: true, retry: true, revision: 'r' },
        resources: [], diagnostics: [],
        mcp: [
          row('from-cursor', { source: 'cursor', target: 'cursor-server' }),
          row('from-claude', { source: 'claude-code', enabled: false }),
          row('direct-std', {}),
        ],
        mcpRevisions: { user: 'mcpjson-rev', project: 'missing' },
        projects: [], loadedExtensions: [],
      }),
      mcpSave: async (input) => { calls.push(input); },
      mcpTest: async () => ({ tools: [] }),
      onEvent: () => () => {},
    };
    window.__calls = calls;
    createRoot(document.getElementById('root')).render(React.createElement('main', { className: 'pireplica', style: { padding: 20 } },
      React.createElement(SettingsFeatures, { page: 'mcp', query: '' })));
  });
  await page.locator('.pi-features__row').first().waitFor();
  const rows = await page.evaluate(() => [...document.querySelectorAll('.pi-features__row')].map(r => ({
    name: r.querySelector('strong')?.textContent,
    buttons: [...r.querySelectorAll('.pi-features__actions button')].map(b => b.textContent),
  })));
  assert(rows.length === 3, `three rows expected: ${JSON.stringify(rows)}`);
  for (const r of rows) {
    assert(r.buttons.includes('禁用') || r.buttons.includes('启用'), `toggle present on ${r.name}: ${JSON.stringify(r.buttons)}`);
  }
  assert(rows.find(r => r.name === 'from-cursor').buttons.includes('禁用'), 'imported row has toggle');
  assert(!rows.find(r => r.name === 'from-cursor').buttons.includes('移除'), 'imported row has no remove');
  assert(rows.find(r => r.name === 'direct-std').buttons.includes('移除'), 'direct row keeps remove');

  // 点击导入行的禁用：revision 用本作用域 mcp.json 的，source 透传
  await page.locator('.pi-features__row', { hasText: 'from-cursor' }).getByRole('button', { name: '禁用', exact: true }).click();
  await page.waitForTimeout(300);
  const saved = await page.evaluate(() => window.__calls);
  assert(saved.length === 1 && saved[0].name === 'from-cursor' && saved[0].source === 'cursor' && saved[0].enabled === false && saved[0].revision === 'mcpjson-rev',
    `imported toggle payload: ${JSON.stringify(saved)}`);
  assert(errors.length === 0, `page errors: ${errors.join('; ')}`);
  await page.screenshot({ path: 'output/playwright/mcp-settings-toggles.png' });
  console.log('mcp-settings-ui: all checks passed');
}
