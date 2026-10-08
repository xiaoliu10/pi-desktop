// 完成态展示回归：已结束任务（once 已触发）灰色卡片 +「已结束」徽标替换开关（ZCode 同款），
// 活跃任务开关不受影响。Vite at :5175; playwright-cli run-code --filename tests/automations-done.browser.cjs
async (page) => {
  const assert = (ok, label) => { if (!ok) throw new Error(label); };
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  const consoleLogs = []; page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') consoleLogs.push(m.type() + ': ' + m.text().slice(0, 200)); });
  await page.setViewportSize({ width: 1280, height: 900 });
  const DAY = 24 * 3600 * 1000;
  const doneTask = { id: 'done-1', name: '已触发的一次任务', cwd: '/tmp/proj', prompt: '只执行过一次的任务', args: {}, permission: 'ask', schedule: { kind: 'once', at: Date.now() - DAY }, enabled: false, runCount: 1, nextRunAt: null, lastRunAt: Date.now() - DAY, updatedAt: Date.now() - DAY };
  const activeTask = { id: 'active-1', name: '每日巡检任务', cwd: '/tmp/proj', prompt: '每天执行的任务', args: {}, permission: 'ask', schedule: { kind: 'cron', expression: '0 9 * * *' }, enabled: true, runCount: 4, nextRunAt: Date.now() + 3600 * 1000, lastRunAt: Date.now() - DAY, updatedAt: Date.now() - DAY };
  await page.route('http://127.0.0.1:5175/automations', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script>' }));
  await page.goto('http://127.0.0.1:5175/automations');
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async ({ doneTask, activeTask }) => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    const { AutomationsPage } = await import('/pi/AutomationsPage.tsx');
    await import('/pi/automations.css');
    await import('/pi/replica-app.css');
    await import('/replica/tokens.css');
    window.localPi = {
      automationSnapshot: async () => ({ tasks: [doneTask, activeTask], workflows: [], runs: [{ id: 'r1', taskId: 'done-1', name: '已触发的一次任务', cwd: '/tmp/proj', trigger: 'schedule', status: 'succeeded', startedAt: Date.now() - 86400000, endedAt: Date.now() - 86400000, stepIndex: 0, steps: [] }] }),
      automationToggle: async () => {}, automationStop: async () => {}, automationRunTask: async () => ({}),
      automationRunWorkflow: async () => ({}), automationSaveTask: async () => ({}), automationSaveWorkflow: async () => ({}),
      automationDeleteTask: async () => {}, automationDeleteWorkflow: async () => {}, automationExport: async () => null,
      automationImport: async () => null, onAutomationChanged: () => () => {},
    };
    const root = createRoot(document.getElementById('root'));
    root.render(React.createElement('main', { className: 'pireplica', style: { display: 'flex', height: '100vh' } },
      React.createElement(AutomationsPage, { projects: [], models: [], onOpenSession: () => {}, onRunTask: () => {} })));
  }, { doneTask, activeTask });
  await page.locator('.pi-auto__card').first().waitFor({ timeout: 15000 }).catch(async e => {
    const dump = await page.evaluate(() => ({ loading: document.body.textContent.includes('正在读取自动化'), err: document.querySelector('.pi-auto__error')?.textContent?.slice(0,150) ?? '', tabs: !!document.querySelector('.pi-auto__tabs'), text: document.body.textContent.slice(0, 400) })).catch((x) => 'dump-failed ' + x);
    throw new Error('card never rendered; pageerrors=' + errors.join('|').slice(0, 200) + ' state=' + JSON.stringify(dump));
  });
  const state = await page.evaluate(() => {
    const done = document.querySelector('.pi-auto__card--done');
    const active = document.querySelector('.pi-auto__card:not(.pi-auto__card--done)');
    const badge = done?.querySelector('.pi-auto__done');
    const doneTitle = done?.querySelector('.pi-auto__card-title');
    const titleColor = doneTitle ? getComputedStyle(doneTitle).color : '';
    const activeSwitch = active?.querySelector('[role=switch]');
    return {
      doneExists: !!done,
      badgeText: badge?.textContent.trim() ?? '',
      doneHasSwitch: !!done?.querySelector('[role=switch]'),
      doneTitleColor: titleColor,
      activeHasSwitch: !!activeSwitch,
      activeSwitchOn: activeSwitch?.classList.contains('is-on') ?? false,
    };
  });
  assert(state.doneExists, 'finished task gets pi-auto__card--done class');
  assert(state.badgeText.includes('已结束'), 'finished task shows 已结束 badge, got: ' + state.badgeText);
  assert(!state.doneHasSwitch, 'finished task has no switch');
  assert(state.activeHasSwitch && state.activeSwitchOn, 'active task keeps its enabled switch');
  await page.screenshot({ path: '/Users/jason/projects/opensource/pi-desktop/output/playwright/automations-done-state.png', fullPage: true });
  assert(errors.length === 0, 'no page errors: ' + errors.join(' | '));
  return 'PASS automations-done: finished once task renders gray card with 已结束 badge (no switch); active task keeps switch';
}
