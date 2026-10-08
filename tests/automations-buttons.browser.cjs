// 自动化页头部按钮 padding 实测。Vite at :5175; playwright-cli run-code --filename tests/automations-buttons.browser.cjs
async (page) => {
  await page.route('http://127.0.0.1:5175/automations', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script>' }));
  await page.goto('http://127.0.0.1:5175/automations');
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    const { AutomationsPage } = await import('/pi/AutomationsPage.tsx');
    // 真实注入顺序（PiReplicaApp）：replica-app → tokens → automations（同特异性 tie 由源顺序裁决）
    await import('/pi/replica-app.css');
    await import('/replica/tokens.css');
    await import('/pi/automations.css');
    window.localPi = {
      automationSnapshot: async () => ({ tasks: [], workflows: [], runs: [] }),
      automationToggle: async () => {}, automationStop: async () => {}, automationRunTask: async () => ({}),
      automationRunWorkflow: async () => ({}), automationSaveTask: async () => ({}), automationSaveWorkflow: async () => ({}),
      automationDeleteTask: async () => {}, automationDeleteWorkflow: async () => {}, automationExport: async () => null,
      automationImport: async () => null, onAutomationChanged: () => () => {},
      modelCatalog: async () => ({ providers: [] }),
    };
    const root = createRoot(document.getElementById('root'));
    root.render(React.createElement('main', { className: 'pireplica', style: { display: 'flex', height: '100vh' } },
      React.createElement(AutomationsPage, { projects: [], models: [], onOpenSession: () => {}, onRunTask: () => {} })));
  });
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.locator('.pi-auto__header').waitFor({ timeout: 15000 }).catch(() => {});
  if (errors.length) throw new Error('page errors: ' + errors.join(' | ').slice(0, 400));
  const info = await page.evaluate(() => {
    const out = [];
    for (const b of document.querySelectorAll('.pi-auto__buttons button')) {
      const cs = getComputedStyle(b);
      out.push({ text: b.textContent.trim().slice(0, 8), padding: cs.padding, border: cs.borderWidth + ' ' + cs.borderColor, fontSize: cs.fontSize, width: b.getBoundingClientRect().width.toFixed(0) });
    }
    return out;
  });
  console.log('BUTTONS', JSON.stringify(info, null, 1));
  // 用户验收标准：水平 padding（第二个值）≥ 11px
  const bad = info.filter(b => parseFloat(b.padding.split(' ')[1] ?? b.padding) < 11);
  if (bad.length) throw new Error('padding 不足: ' + JSON.stringify(bad));
}
