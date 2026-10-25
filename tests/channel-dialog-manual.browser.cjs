// 渠道配置对话框（手动配置 tab）：ZCode 卡片式分组 + webhook 缺失警告。
// 背景：用户配了钉钉 AppKey（Stream 双向在线）但没填 group webhook → 任务通知一条不发，
// 旧表单还把两个通道平铺在一起、无任何提示（真实反馈「配好了但没用」）。
// Synthetic host（同 missing-stream.browser.cjs 手法）：route 拦 + 注入 window.localPi mock，
// 挂载真实 PiReplicaApp，从设置页真实点进渠道配置对话框。
// 跑法：playwright-cli -s=chdialog run-code --filename tests/channel-dialog-manual.browser.cjs
// 破坏-恢复：去掉 .pi-chdialog__warn 渲染或分组类名，本测试必须挂。
async (page) => {
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.setViewportSize({ width: 1280, height: 900 });
  const url = 'http://127.0.0.1:5175/chdialog-harness';
  await page.route(url, route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script>' }));
  await page.goto(url);
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    await import('/styles.css'); await import('/replica/tokens.css');
    const { default: App, usePiStore } = await import('/pi/PiReplicaApp.tsx');
    window.store = usePiStore;
    // im 配置：dingtalk + twoWay 开着 + AppKey 有 + webhook 空（复现用户真实状态）
    window.im = { provider: 'dingtalk', webhook: '', secret: '', notifyCompleted: true, notifyError: true, notifyAttention: true, appKey: 'ding-probe-key', appSecret: 'probe-secret', twoWay: true, bindings: {} };
    window.localPi = {
      settingsSnapshot: async () => { throw Error('synthetic settings disabled'); },
      environment: async () => { throw Error('synthetic discovery disabled'); },
      sessions: async () => [], runs: async () => [], archivedSessions: async () => [],
      onEvent: fn => { window.emit = fn; }, history: async () => ({ branch: [] }),
      prompt: async () => { throw Error('synthetic'); },
      imConfig: async () => window.im,
      imSave: async (patch) => { window.im = { ...window.im, ...patch }; },
      imTest: async () => ({ ok: true }),
      remoteStatus: async () => ({ running: false, urls: [], viewers: 0 }),
      listFiles: async () => [], externalApps: async () => [], projectBranch: async () => null,
      gitStatus: async () => ({ isRepo: false, files: [] }),
    };
    // Proxy 兜底：未显式 mock 的 IPC/订阅方法一律返回空 promise，避免 effect 崩溃导致 root 空。
    window.localPi = new Proxy(window.localPi, { get: (t, k) => (k in t ? t[k] : async () => undefined) });
    usePiStore.getState().init();
    await new Promise(resolve => setTimeout(resolve, 0));
    usePiStore.setState({ ready: true, view: 'settings', settingsPage: 'workspace', lang: 'zh', error: undefined });
    createRoot(document.getElementById('root')).render(React.createElement(App));
  });
  await page.waitForTimeout(1500);
  // 真实点击：RemotePane 的渠道行（configChannel 是 RemotePane 局部 state，走 UI 路径）
  // 真实点击：RemotePane 的渠道行（configChannel 是 RemotePane 局部 state，走 UI 路径）。
  // 用 evaluate 触发而非 locator.click：CLI 沙箱里 locator 对 route-fulfill 的页面
  // 偶发不可交互判定；React 的 onClick 由原生 click 事件驱动，等价真实用户点击。
  await page.evaluate(() => document.querySelector('.pi-remote__channelitem')?.click());
  await page.waitForTimeout(900);
  await page.evaluate(() => { const t = [...document.querySelectorAll('[role="tab"]')].find(x => /手动|Manual/.test(x.textContent || '')); if (t) t.click(); });
  await page.waitForTimeout(600);

  const probe = await page.evaluate(() => {
    const d = document.querySelector('.pi-chdialog');
    if (!d) return { ok: false, why: 'dialog absent' };
    const groups = [...d.querySelectorAll('.pi-chdialog__group')];
    const warn = d.querySelector('.pi-chdialog__warn');
    const webhook = [...d.querySelectorAll('input.pi-mono')].find(i => (i.placeholder || '').includes('oapi.dingtalk.com'));
    return {
      ok: true,
      groups: groups.length,
      titles: groups.map(g => (g.querySelector('.pi-chdialog__grouptitle')?.textContent || '').trim()),
      cards: d.querySelectorAll('.pi-settingrow--card').length,
      // 通知场景三项合并为一张紧凑卡（不再是三张松散 settingrow）
      notifRows: d.querySelectorAll('.pi-chdialog__notifrow').length,
      // 四个原生 checkbox（双向 + 三通知）全部换成 role=switch 滑块
      switches: d.querySelectorAll('[role="switch"]').length,
      nativeCheckboxes: d.querySelectorAll('input[type="checkbox"]').length,
      warn: warn ? (warn.textContent || '').trim().slice(0, 60) : null,
      webhook: Boolean(webhook),
      webhookEmpty: webhook ? webhook.value === '' : null,
      // 两个通道的输入都要在（通知 webhook + 双向 AppKey）
      appKey: [...d.querySelectorAll('input.pi-mono')].some(i => i.value === 'ding-probe-key'),
    };
  });

  let checks = 0;
  const assert = (ok, message) => { if (!ok) throw Error(message); checks++; };
  assert(probe.ok, '对话框渲染：' + (probe.why || ''));
  assert(probe.groups >= 3, `能力分组 >=3（实际 ${probe.groups}：${JSON.stringify(probe.titles)}）`);
  assert(probe.webhook, '通知 webhook 输入框在');
  assert(probe.webhookEmpty === true, 'webhook 为空（复现用户状态）');
  assert(probe.appKey, '双向 AppKey 在');
  assert(Boolean(probe.warn), 'webhook 空 + 通知开关开着 → 醒目警告必须显示');
  // 美化后：5 张输入/双向 settingrow + 通知三场合一张卡；原生蓝方块 checkbox 全部换成滑块
  assert(probe.cards === 5, `卡片布局（webhook/secret/appKey/appSecret/双向 = 5，实际 ${probe.cards}）`);
  assert(probe.notifRows === 3, `通知场景三项合一张卡（实际 ${probe.notifRows} 行）`);
  assert(probe.switches === 4, `4 个滑块开关（双向+三通知，实际 ${probe.switches}）`);
  assert(probe.nativeCheckboxes === 0, `无原生 checkbox（实际 ${probe.nativeCheckboxes}）`);
  const errorLine = errors.length ? 'ERRORS ' + errors.slice(0, 3).join(' | ') : 'ERRORS none';
  console.log('PROBE ' + JSON.stringify(probe));
  console.log(errorLine);
  console.log(`PASS (${checks} checks)`);
  return { checks, errors, probe };
}