async (page) => {
  const assert = (ok, l) => { if (!ok) throw new Error(l); };
  await page.setViewportSize({ width: 1100, height: 760 });
  await page.route('http://127.0.0.1:5175/subgrp', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<html><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script></body></html>' }));
  await page.goto('http://127.0.0.1:5175/subgrp');
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  const mkGrep = (id, cmd, status) => ({ kind: 'tool', id, callId: id, phase: 'result', tool: 'bash', summary: cmd, status, detailLines: ['$ ' + cmd], argumentsText: JSON.stringify({ command: cmd }) });
  await page.evaluate(async ({ grep1, grep2, grep3 }) => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    const { ChatView } = await import('/replica/chat/ChatView.tsx');
    await import('/replica/tokens.css'); await import('/replica/chat/chat.css'); await import('/pi/replica-app.css');
    const msg = { id: 't1', role: 'assistant', parts: [
      { kind: 'thinking', id: 'th1', text: '先搜一下相关代码' },
      grep1, grep2, grep3,
      { kind: 'tool', id: 'tl-edit', callId: 'c-edit', phase: 'result', tool: 'edit', summary: 'a.tsx', status: 'done', argumentsText: JSON.stringify({ path: 'src/a.tsx' }) },
    ], };
    const labels = { you: '你', working: '工作中', toolRunning: '运行中', toolDone: '完成', toolError: '出错' };
    window.__rerender = (parts) => createRoot(document.getElementById('root')).render(React.createElement('main', { className: 'pireplica', style: { padding: 24 } },
      React.createElement(ChatView, { messages: [{ id: 't1', role: 'assistant', parts }], running: true, queued: 0, demo: false, labels })));
    window.__rerender([msg.parts[0], grep1, grep2, { ...grep3, status: 'running' }, msg.parts[4]]);
  }, { grep1: mkGrep('g1', 'grep -n "很高兴唤醒你" src/a.tsx | head -4', 'done'), grep2: mkGrep('g2', 'grep -rn "很高兴唤醒你" src/renderer/ | head -2', 'done'), grep3: mkGrep('g3', 'grep -rn "可以帮你" src/renderer/pages/*.tsx', 'done') });
  await page.waitForTimeout(400);
  // 运行中：子组钉住展开，头行「查阅 · 3 搜索」，运行中的子项有加粗正在执行
  const live = await page.evaluate(() => {
    const head = document.querySelector('.pi-execution__subhead')?.textContent ?? '';
    const sub = document.querySelector('.pi-execution__subitems');
    const children = sub ? [...sub.querySelectorAll(':scope > .pi-tool')] : [];
    return {
      head, childCount: children.length,
      hasBorder: sub ? getComputedStyle(sub).borderLeftWidth : null,
      bold: sub?.querySelector('.pi-tool strong.pi-execution__thinking')?.textContent ?? null,
      loneEditGrouped: !!sub?.querySelector('.pi-tool[data-lone]'),
      totalTools: document.querySelectorAll('.pi-execution__steps .pi-tool').length,
    };
  });
  assert(live.head.includes('查阅 · 3 搜索'), `group header: ${live.head}`);
  assert(live.childCount === 3, `three children inside sub group: ${live.childCount}`);
  assert(live.hasBorder === '1px', `left guide line: ${live.hasBorder}`);
  assert(live.bold === '正在执行', `running child bold label: ${live.bold}`);
  assert(live.totalTools === 4, `edit stays outside the group (4 tool rows total): ${live.totalTools}`);
  await page.screenshot({ path: 'output/playwright/tool-subgroup-live.png' });

  // 完成后：默认折叠，头行可点击展开
  await page.evaluate(() => {
    const root = document.getElementById('root');
    root.fill = undefined;
    window.__rerender !== undefined; // noop keep
  });
  await page.evaluate(() => { /* re-render done state */ });
  // 用第二组消息渲染完成态（独立页面更稳）
  await page.goto('http://127.0.0.1:5175/subgrp');
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async ({ grep1, grep2, grep3 }) => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    const { ChatView } = await import('/replica/chat/ChatView.tsx');
    await import('/replica/tokens.css'); await import('/replica/chat/chat.css'); await import('/pi/replica-app.css');
    const msg = { id: 't1', role: 'assistant', parts: [
      { kind: 'thinking', id: 'th1', text: '先搜一下相关代码' }, grep1, grep2, grep3,
      { kind: 'tool', id: 'tl-edit', callId: 'c-edit', phase: 'result', tool: 'edit', summary: 'a.tsx', status: 'done', argumentsText: JSON.stringify({ path: 'src/a.tsx' }) },
    ] };
    const labels = { you: '你', working: '工作中', toolRunning: '运行中', toolDone: '完成', toolError: '出错' };
    createRoot(document.getElementById('root')).render(React.createElement('main', { className: 'pireplica', style: { padding: 24 } },
      React.createElement(ChatView, { messages: [msg], running: false, queued: 0, demo: false, labels })));
  }, { grep1: mkGrep('g1', 'grep -n "x" a.tsx', 'done'), grep2: mkGrep('g2', 'grep -rn "y" src/', 'done'), grep3: mkGrep('g3', 'grep -rn "z" pages/', 'done') });
  await page.waitForTimeout(300);
  const done = await page.evaluate(() => {
    const head = document.querySelector('.pi-execution__subhead');
    const sub = document.querySelector('.pi-execution__subitems');
    return { head: head?.textContent ?? '', collapsed: !sub, chevronOpen: head?.querySelector('.pi-execution__chevron')?.getAttribute('class')?.includes('--open') };
  });
  assert(done.collapsed, `done sub group collapsed by default`);
  await page.locator('.pi-execution__summary').first().click();
  await page.locator('.pi-execution__subhead').waitFor();
  assert(!await page.evaluate(() => !!document.querySelector('.pi-execution__subitems')), 'main expanded: sub still collapsed by default');
  await page.locator('.pi-execution__subhead').click();
  await page.waitForTimeout(150);
  const opened = await page.evaluate(() => ({ sub: !!document.querySelector('.pi-execution__subitems'), rows: document.querySelectorAll('.pi-execution__subitems .pi-tool').length }));
  assert(opened.sub && opened.rows === 3, `manual expand works: ${JSON.stringify(opened)}`);
  await page.screenshot({ path: 'output/playwright/tool-subgroup-done.png' });
}
