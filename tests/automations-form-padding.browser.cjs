// 回归：自动化页按钮 padding 依赖 automations.css 在 tokens.css 之后加载（同特异性 tie 由源顺序裁决）。
// 此前 automations.css 从 AutomationsPage 模块注入、早于 tokens 的 .pireplica button reset，
// 「保存任务」等按钮 padding 被整条压掉文字贴边。修复 = import 挪至 PiReplicaApp 的 tokens 之后。
// 锁四层：form footer 保存/取消、tabs、card footer 操作行、模板卡 + primary hover 背景不被 hover 覆盖。
// Vite at :5175; playwright-cli run-code --filename tests/automations-form-padding.browser.cjs
async (page) => {
  const assert = (ok, label) => { if (!ok) throw new Error(label); };
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => { try { localStorage.setItem('pi-automation-tab', 'tasks'); } catch { /* 新 context */ } });
  await page.route('http://127.0.0.1:5175/automations', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script>' }));
  await page.goto('http://127.0.0.1:5175/automations');
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    const { AutomationsPage } = await import('/pi/AutomationsPage.tsx');
    // 真实注入顺序（PiReplicaApp）：replica-app(79) → tokens(80) → automations(81，修复后挪到这里)
    await import('/pi/replica-app.css');
    await import('/replica/tokens.css');
    await import('/pi/automations.css');
    window.localPi = {
      automationSnapshot: async () => ({ tasks: [{ id: 't1', name: '每日巡检任务', cwd: '/tmp/proj', prompt: '每天执行的任务', args: {}, permission: 'ask', schedule: { kind: 'cron', expression: '0 9 * * *' }, enabled: true, runCount: 4, nextRunAt: Date.now() + 3600 * 1000, lastRunAt: Date.now() - 86400000, updatedAt: 1 }], workflows: [], runs: [] }),
      automationToggle: async () => {}, automationStop: async () => {}, automationRunTask: async () => ({}),
      automationRunWorkflow: async () => ({}), automationSaveTask: async () => ({}), automationSaveWorkflow: async () => ({}),
      automationDeleteTask: async () => {}, automationDeleteWorkflow: async () => {}, automationExport: async () => null,
      automationImport: async () => null, onAutomationChanged: () => () => {},
    };
    const root = createRoot(document.getElementById('root'));
    root.render(React.createElement('main', { className: 'pireplica', style: { display: 'flex', height: '100vh' } },
      React.createElement(AutomationsPage, { projects: [], models: [], onOpenSession: () => {}, onRunTask: () => {} })));
  });
  await page.locator('.pi-auto__buttons').waitFor({ timeout: 15000 });
  // 列表态：tabs 与模板卡 padding
  const listState = await page.evaluate(() => {
    const probe = (el) => { const cs = getComputedStyle(el); return { px: parseFloat(cs.paddingLeft), py: parseFloat(cs.paddingTop), justify: cs.justifyContent, gap: cs.columnGap }; };
    return {
      tab: probe(document.querySelector('.pi-auto__tabs button')),
      template: probe(document.querySelector('.pi-auto__templates button')),
      cardFooter: probe(document.querySelector('.pi-auto__card footer button')),
    };
  });
  assert(listState.tab.py >= 12, 'tab 垂直 padding ≥12px，实际 ' + listState.tab.py);
  assert(listState.template.px >= 14 && listState.template.py >= 17 && listState.template.justify === 'flex-start', '模板卡应保持宽敞左对齐（17px 14px / flex-start），实际 ' + JSON.stringify(listState.template));
  assert(listState.cardFooter.px === 8 && listState.cardFooter.py === 5, '卡片操作按钮应保持紧凑（垂直5 水平8），实际 ' + JSON.stringify(listState.cardFooter));
  // 打开表单：footer 保存/取消按钮 padding
  await page.locator('.pi-auto__buttons button.pi-auto__primary').click();
  await page.locator('.pi-auto__form>footer').waitFor({ timeout: 5000 });
  const save = page.locator('.pi-auto__form>footer button.pi-auto__primary');
  const formPadding = await page.evaluate(() => {
    const probe = (el) => { const cs = getComputedStyle(el); return { text: el.textContent.trim().slice(0, 6), px: parseFloat(cs.paddingLeft), py: parseFloat(cs.paddingTop), bg: cs.backgroundColor, color: cs.color }; };
    return { cancel: probe([...document.querySelectorAll('.pi-auto__form>footer button')][0]), save: probe([...document.querySelectorAll('.pi-auto__form>footer button')][1]) };
  });
  assert(formPadding.save.px >= 11 && formPadding.save.py >= 7, '保存任务应有内边距 ≥7px 11px，实际 ' + JSON.stringify(formPadding.save));
  assert(formPadding.cancel.px >= 11, '取消按钮水平 padding ≥11px，实际 ' + formPadding.cancel.px);
  // hover 不吃掉 primary：黑底按钮悬停仍保持深色背景（白字可见）
  await save.hover();
  await page.waitForTimeout(120);
  const hoverBg = await save.evaluate(el => getComputedStyle(el).backgroundColor);
  assert(hoverBg === formPadding.save.bg, 'primary hover 背景不应被 hover 规则覆盖（文字会不可见）: ' + hoverBg + ' vs ' + formPadding.save.bg);
  await page.locator('.pi-auto__form>footer').scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/Users/jason/projects/opensource/pi-desktop/output/playwright/automations-form-padding.png', fullPage: true });
  assert(errors.length === 0, 'no page errors: ' + errors.join(' | '));
  return 'PASS automations-form-padding: save/cancel padding, tabs, card footer 5px 8px, template cards, primary hover intact';
}
