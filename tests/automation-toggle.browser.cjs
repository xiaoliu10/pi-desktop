// 自动化任务卡片的 enable/disable 开关（对齐 ZCode 任务卡）：
// role=switch + aria-checked 反映 enabled，点击调 automationToggle，
// 停用态状态文案为「已暂停」。Vite at :5175; playwright-cli run-code --filename tests/automation-toggle.browser.cjs
async (page) => {
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  const url = 'http://127.0.0.1:5175/automations';
  await page.route(url, route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script>' }));
  await page.addInitScript(() => { try { localStorage.setItem('pi-automation-tab', 'tasks'); } catch { /* 新 context */ } });
  await page.goto(url);
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    const { AutomationsPage } = await import('/pi/AutomationsPage.tsx');
    await import('/pi/automations.css'); await import('/pi/replica-app.css'); await import('/replica/tokens.css');
    const task = (id, name, enabled, runCount = 3, maxRuns) => ({ id, name, cwd: '/Users/jason/projects/pi-desktop', prompt: 'prompt ' + id, args: {}, thinking: 'off', permission: 'ask', schedule: { kind: 'cron', expression: '0 9 * * *' }, enabled, runCount, maxRuns, nextRunAt: Date.now() + 3600_000, updatedAt: 0 });
    // t3 跑满 3/3 次：服务端已达上限后 enabled 自动为 false，文案应显示「已结束」而非「已暂停」。
    const snapshot = { tasks: [task('t1', '晚上18点发生产', true), task('t2', '每晚22点发布', false), task('t3', '只跑三次的任务', false, 3, 3)], workflows: [], runs: [] };
    window.localPi = {
      automationSnapshot: async () => snapshot,
      automationToggle: async id => { if (window.__toggleShouldThrow) throw new Error('已达到执行次数上限，请编辑上限'); snapshot.tasks = snapshot.tasks.map(t => t.id === id ? { ...t, enabled: !t.enabled } : t); },
      automationStop: async () => {}, automationRunTask: async () => ({}), automationRunWorkflow: async () => ({}),
      automationSaveTask: async () => ({}), automationSaveWorkflow: async () => ({}), automationDeleteTask: async () => {},
      automationDeleteWorkflow: async () => {}, automationExport: async () => null, automationImport: async () => null,
      onAutomationChanged: () => () => {}, modelCatalog: async () => ({ providers: [] }),
    };
    createRoot(document.getElementById('root')).render(React.createElement('main', { className: 'pireplica' }, React.createElement(AutomationsPage, { projects: [], models: [], onOpenSession: () => {}, onRunTask: () => {} })));
  });
  await page.locator('[role="switch"]').first().waitFor({ timeout: 15000 }).catch(async e => {
    const dump = await page.evaluate(() => ({ err: document.querySelector('.pi-auto__error')?.textContent?.slice(0, 120) ?? '', text: document.body.textContent.slice(0, 250) })).catch((x) => 'dump-failed ' + x);
    throw new Error('switch never rendered: ' + JSON.stringify(dump).slice(0, 400));
  });

  // 1. 开关只出现在未结束的卡片：t1 启用、t2 停用；t3 跑满 3/3 已结束 →「已结束」徽标替换开关（ZCode 同款完成态）
  const switches = await page.$$eval('[role="switch"]', els => els.map(e => ({ checked: e.getAttribute('aria-checked'), label: e.getAttribute('aria-label'), on: e.classList.contains('is-on') })));
  if (switches.length !== 2) throw new Error('期望 2 个任务开关（t3 已结束用徽标替代），实际 ' + switches.length);
  if (switches[0].checked !== 'true' || switches[1].checked !== 'false') throw new Error('aria-checked 未反映 enabled: ' + JSON.stringify(switches));
  if (!switches[0].label.includes('暂停') || !switches[1].label.includes('启用')) throw new Error('aria-label 语义错误: ' + JSON.stringify(switches));
  if (switches[0].on !== true || switches[1].on !== false) throw new Error('is-on class 未反映 enabled: ' + JSON.stringify(switches));
  const t3Badge = await page.$$eval('.pi-auto__card--done .pi-auto__done', els => els.map(e => e.textContent.trim()));
  if (t3Badge.length !== 1 || !t3Badge[0].includes('已结束')) throw new Error('达上限卡片应显示已结束徽标: ' + JSON.stringify(t3Badge));

  // 2. 状态文案三态：启用→下次运行，停用→已暂停，达上限自动收尾→已结束（优先于已暂停）
  const scheduleText = await page.$$eval('.pi-auto__schedule', els => els.map(e => e.textContent.replace(/\s+/g, ' ')));
  if (!scheduleText[0].includes('下次')) throw new Error('启用卡片应显示下次运行: ' + scheduleText[0]);
  if (!scheduleText[1].includes('已暂停')) throw new Error('停用卡片应显示已暂停: ' + scheduleText[1]);
  if (!scheduleText[2].includes('已结束') || scheduleText[2].includes('已暂停')) throw new Error('达上限卡片应显示已结束: ' + scheduleText[2]);

  // 3. 点击停用卡片的开关 → 调 automationToggle('t2') → aria-checked 翻为 true
  // 按卡片标题定位目标开关（多个停用卡时不能用「第一个 checked=false」）
  const t2switch = page.locator('.pi-auto__card').filter({ hasText: '每晚22点发布' }).locator('[role="switch"]');
  await t2switch.click();
  await page.waitForFunction(() => document.querySelectorAll('[role="switch"]')[1]?.getAttribute('aria-checked') === 'true', { timeout: 5000 });
  const after = await page.$$eval('[role="switch"]', els => els.map(e => e.getAttribute('aria-checked')));
  if (JSON.stringify(after) !== JSON.stringify(['true', 'true'])) throw new Error('点击未翻转开关: ' + JSON.stringify(after));

  // 4. toggle 被服务拒绝（如达上限再启用）→ 错误条 role=alert + 开关保持停用
  await page.evaluate(() => { window.__toggleShouldThrow = true; });
  await t2switch.click();
  await page.locator('.pi-auto__error[role="alert"]').waitFor({ timeout: 5000 });
  const [errText, t2After] = await page.evaluate(() => [document.querySelector('.pi-auto__error')?.textContent, [...document.querySelectorAll('.pi-auto__card')].find(c => c.textContent.includes('每晚22点发布'))?.querySelector('[role="switch"]')?.getAttribute('aria-checked')]);
  if (!String(errText).includes('已达到执行次数上限')) throw new Error('toggle 失败应展示错误条: ' + errText);
  if (t2After !== 'true') throw new Error('toggle 失败后开关应保持原状（启用）: ' + t2After);
  await page.evaluate(() => { window.__toggleShouldThrow = false; });

  // 5. 工作流 tab 不应出现开关
  await page.locator('.pi-auto__tabs button', { hasText: '工作流' }).click();
  await page.waitForFunction(() => document.querySelectorAll('[role="switch"]').length === 0, { timeout: 5000 });
  const wfSwitches = await page.locator('[role="switch"]').count();
  if (wfSwitches !== 0) throw new Error('工作流区不应有开关，实际 ' + wfSwitches);
  if (errors.length) throw new Error('page errors: ' + errors.join(' | ').slice(0, 400));
  return { switches, scheduleText, after };
}
