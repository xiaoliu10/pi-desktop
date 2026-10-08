// 回归：自动化表单 footer 按钮 padding 被 tokens.css 的 .pireplica button reset（后加载、同特异性）
// 整体压掉，「保存任务」文字贴边。修复 = automations.css 裸按钮规则提升为 .pireplica .pi-auto 前缀。
// Vite at :5175; playwright-cli run-code --filename tests/automations-form-padding.browser.cjs
async (page) => {
  const assert = (ok, label) => { if (!ok) throw new Error(label); };
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route('http://127.0.0.1:5175/automations', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script>' }));
  await page.goto('http://127.0.0.1:5175/automations');
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    const { AutomationsPage } = await import('/pi/AutomationsPage.tsx');
    // 真实注入顺序（PiReplicaApp）：automations(11) → replica-app(79) → tokens(80)
    await import('/pi/automations.css');
    await import('/pi/replica-app.css');
    await import('/replica/tokens.css');
    window.localPi = {
      automationSnapshot: async () => ({ tasks: [], workflows: [], runs: [] }),
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
  const tabPadding = await page.evaluate(() => { const el = document.querySelector('.pi-auto__tabs button'); const cs = getComputedStyle(el); return { py: parseFloat(cs.paddingTop), px: parseFloat(cs.paddingLeft) }; });
  await page.locator('.pi-auto__tabs button').first().click();
  await page.locator('.pi-auto__buttons button.pi-auto__primary').click();
  await page.locator('.pi-auto__form>footer').waitFor({ timeout: 5000 });
  assert(tabPadding.py >= 12, 'tab 按钮垂直 padding 应 ≥12px（同受 reset 压制），实际 ' + tabPadding.py);
  const padding = await page.evaluate(() => {
    const probe = (el) => { const cs = getComputedStyle(el); return { text: el.textContent.trim().slice(0, 6), px: parseFloat(cs.paddingLeft), py: cs.paddingTop }; };
    return {
      cancel: probe([...document.querySelectorAll('.pi-auto__form>footer button')][0]),
      save: probe([...document.querySelectorAll('.pi-auto__form>footer button')][1]),
    };
  });
  assert(padding.save.px >= 11, '保存任务水平 padding 应 ≥11px，实际 ' + padding.save.px);
  assert(parseFloat(padding.save.py) >= 7, '保存任务垂直 padding 应 ≥7px，实际 ' + padding.save.py);
  assert(padding.cancel.px >= 11, '取消按钮水平 padding 应 ≥11px，实际 ' + padding.cancel.px);
  await page.locator('.pi-auto__form>footer').scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/Users/jason/projects/opensource/pi-desktop/output/playwright/automations-form-padding.png', fullPage: true });
  assert(errors.length === 0, 'no page errors: ' + errors.join(' | '));
  return 'PASS automations-form-padding: footer save/cancel buttons have proper padding under tokens.css reset';
}
