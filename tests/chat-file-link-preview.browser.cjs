// 聊天里的 `file://` 交付文件链接必须默认在右侧工作台打开预览，不再直接交给系统默认应用。
// 用户 2026-11-04：「md 文档为什么不能在右侧边栏展示了 点击之后使用的系统默认的工具
// 这个不对吧，应该做成右侧边栏支持 md 文档查看并且支持预览模式」。
//
// 跑法：playwright-cli -s=chatlink run-code --filename tests/chat-file-link-preview.browser.cjs
// 破坏-恢复：把 file:// 分支改回直接 openLocalFile，本测试必挂。
async (page) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  const url = 'http://127.0.0.1:5175/chat-file-link-harness';
  await page.route(url, route => route.fulfill({ contentType: 'text/html', body: '<div id="root" class="pireplica"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script>' }));
  await page.goto(url);
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    window.__openedLocal = [];   // 走系统默认应用的调用
    window.__previewed = [];     // 走侧栏预览的调用
    window.localPi = { openLocalFile: (p) => { window.__openedLocal.push(p); return Promise.resolve({ action: 'opened' }); } };
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    await import('/styles.css'); await import('/replica/tokens.css'); await import('/replica/chat/chat.css');
    const { ChatMarkdown, MarkdownWithPreview } = await import('/replica/chat/ChatView.tsx');
    const text = '交付文件：[说明](file:///tmp/delivery.md)，还有 [报告](file:///tmp/report.md)。';
    const root = createRoot(document.getElementById('root'));
    // 两种形态都要测：有预览通道（生产路径 → 侧栏）与无通道（replica 单独渲染 → 系统应用）。
    window.__render = (withPreview) => {
      root.render(React.createElement('div', { id: 'host' },
        withPreview
          ? React.createElement(MarkdownWithPreview, { text, zh: true, onOpenFile: (path) => window.__previewed.push(path) })
          : React.createElement(ChatMarkdown, { text, zh: true })));
    };
    window.__render(false);
  });
  await page.waitForSelector('.pi-md a', { timeout: 15000 });

  let checks = 0;
  const assert = (ok, message) => { if (!ok) throw Error(message); checks++; };

  const links = await page.evaluate(() => [...document.querySelectorAll('.pi-md a')].map(a => a.getAttribute('href')));
  assert(links.length === 2, `两个文件链接都渲染（实际 ${JSON.stringify(links)}）`);

  // 无预览 provider 时（replica 单独渲染 / 无会话 cwd）：必须退化到 openLocalFile，不能变成死链。
  await page.evaluate(() => document.querySelector('.pi-md a').click());
  await page.waitForTimeout(300);
  const fallback = await page.evaluate(() => ({ opened: window.__openedLocal, previewed: window.__previewed, stillThere: document.querySelectorAll('.pi-md a').length }));
  assert(fallback.opened.length === 1 && fallback.opened[0] === '/tmp/delivery.md',
    `无预览通道时退化到系统应用（实际 ${JSON.stringify(fallback.opened)}）`);
  assert(fallback.stillThere === 2, `点击后消息仍在，无顶层导航（实际 ${fallback.stillThere}）`);

  // 有预览通道时（生产路径）：点击必须走侧栏预览，绝不调 openLocalFile。
  await page.evaluate(() => { window.__openedLocal.length = 0; window.__render(true); });
  await page.waitForSelector('.pi-md a', { timeout: 10000 });
  await page.evaluate(() => document.querySelector('.pi-md a').click());
  await page.waitForTimeout(300);
  const viaSidebar = await page.evaluate(() => ({ opened: window.__openedLocal, previewed: window.__previewed }));
  assert(viaSidebar.previewed.length === 1 && viaSidebar.previewed[0] === '/tmp/delivery.md',
    `有预览通道时点链接走侧栏预览（实际 previewed=${JSON.stringify(viaSidebar.previewed)}）`);
  assert(viaSidebar.opened.length === 0,
    `有预览通道时不再调用系统应用（实际 opened=${JSON.stringify(viaSidebar.opened)}）`);

  // 右键 file:// 链接：必须给出「用系统默认应用打开」的可选出口。
  const box = await page.evaluate(() => {
    const r = document.querySelector('.pi-md a').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.click(box.x, box.y, { button: 'right' });
  await page.waitForTimeout(250);
  const menuItems = await page.evaluate(() => [...document.querySelectorAll('.pi-linkmenu__item')].map(e => e.textContent?.trim() || ''));
  assert(menuItems.some(t => t.includes('系统默认应用打开')),
    `右键菜单含「用系统默认应用打开」（实际 ${JSON.stringify(menuItems)}）`);

  console.log(`PASS (${checks} checks): file:// 链接默认侧栏预览，无通道时退化系统应用，右键保留外部打开入口`);
  return { checks };
}
