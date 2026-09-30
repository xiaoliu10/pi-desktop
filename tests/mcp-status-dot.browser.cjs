// MCP 连接状态点（ZCode 同款）：进入 MCP 页自动探测启用服务——
// 连接中橙点闪烁 → 成功绿点（含工具数）/ 失败红点；禁用服务灰点不探测。
// playwright-cli -s mcpdot open http://127.0.0.1:5175 && playwright-cli -s mcpdot run-code --filename tests/mcp-status-dot.browser.cjs
async (page) => {
  const assert = (ok, label) => { if (!ok) throw new Error(label); };
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.setViewportSize({ width: 1200, height: 760 });
  await page.route('http://127.0.0.1:5175/mcp-dot', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script>' }));
  await page.goto('http://127.0.0.1:5175/mcp-dot');
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    const { SettingsFeatures } = await import('/pi/SettingsFeatures.tsx');
    await import('/replica/tokens.css'); await import('/pi/settings-features.css'); await import('/pi/replica-app.css');
    const row = (name, extra) => ({ id: `id-${name}`, name, scope: 'user', transport: 'stdio', target: name, enabled: true, path: '/tmp/mcp.json', revision: 'rev', ...extra });
    const tested = [];
    window.localPi = {
      settingsSnapshot: async () => ({
        preferences: {}, ai: { defaultProvider: '', defaultModel: '', defaultThinkingLevel: 'off', autoCompact: true, retry: true, revision: 'r' },
        resources: [], diagnostics: [],
        mcp: [
          row('ok-server'),
          row('slow-server'),
          row('bad-server'),
          row('disabled-server', { enabled: false }),
        ],
        mcpRevisions: { user: 'rev', project: 'missing' },
        projects: [], loadedExtensions: [],
      }),
      mcpTest: async (id) => {
        tested.push(id);
        if (id === 'id-ok-server') return { tools: ['t1', 't2'] };
        if (id === 'id-slow-server') await new Promise(r => setTimeout(r, 700));
        if (id === 'id-bad-server') throw new Error('spawn npx ENOENT');
        return { tools: [] };
      },
      mcpSave: async () => {},
      onEvent: () => () => {},
    };
    createRoot(document.getElementById('root')).render(React.createElement('main', { className: 'pireplica', style: { padding: 20 } },
      React.createElement(SettingsFeatures, { page: 'mcp', query: '' })));
    window.tested = tested;
  });
  await page.locator('.pi-features__row').first().waitFor();
  const dotOf = (name) => page.evaluate((name) => {
    const rows = [...document.querySelectorAll('.pi-features__row')];
    const r = rows.find(x => x.querySelector('strong')?.textContent?.includes(name));
    const dot = r?.querySelector('.pi-mcpdot');
    return dot ? { cls: [...dot.classList].find(c => c.startsWith('pi-mcpdot--')), label: dot.getAttribute('aria-label') } : null;
  }, name);
  // 初期：探测中的服务显示“连接中”橙点（用带延迟的 slow-server 捕获该阶段），禁用服务灰点
  const early = await dotOf('slow-server');
  assert(early?.cls === 'pi-mcpdot--wait', `probing server shows connecting orange dot, got ${JSON.stringify(early)}`);
  const off = await dotOf('disabled-server');
  assert(off?.cls === 'pi-mcpdot--off', `disabled server is grey, got ${JSON.stringify(off)}`);
  // 成功流转：绿点 + 工具数
  await page.waitForFunction(() => [...document.querySelectorAll('.pi-features__row')].some(r => r.querySelector('.pi-mcpdot--ok')), null, { timeout: 3000 });
  const ok = await dotOf('ok-server');
  assert(ok?.cls === 'pi-mcpdot--ok' && (ok.label || '').includes('2 个工具'), `ok-server green with tool count, got ${JSON.stringify(ok)}`);
  // 失败流转：红点 + 错误摘要
  await page.waitForFunction(() => [...document.querySelectorAll('.pi-features__row')].some(r => r.querySelector('.pi-mcpdot--fail')), null, { timeout: 3000 });
  const bad = await dotOf('bad-server');
  assert(bad?.cls === 'pi-mcpdot--fail' && (bad.label || '').includes('ENOENT'), `bad-server red with error, got ${JSON.stringify(bad)}`);
  // slow-server 最终也成功
  await page.waitForFunction(() => [...document.querySelectorAll('.pi-features__row')].filter(r => r.querySelector('.pi-mcpdot--ok')).length >= 2, null, { timeout: 3000 });
  // 禁用服务没有被探测
  const tested = await page.evaluate(() => window.tested);
  assert(!tested.includes('id-disabled-server'), `disabled server must not be probed, tested=${JSON.stringify(tested)}`);
  assert(errors.length === 0, `no page errors: ${errors.join('; ')}`);
  await page.screenshot({ path: 'output/playwright/mcp-status-dots.png' });
}
