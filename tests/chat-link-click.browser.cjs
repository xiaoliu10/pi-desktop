// 聊天消息外链点击：GFM autolink 的裸 URL <a> 必须走 window.open（系统浏览器），
// 绝不允许主窗口顶层导航（旧缺陷：点击 → will-navigate 拦截 → about:blank#blocked
// → did-navigate 防护重载入口 → 整个 app 重置回首页）。
// 跑法：playwright-cli -s=chatlink run-code --filename tests/chat-link-click.browser.cjs
// 破坏-恢复：去掉 ChatMarkdown 的 a 覆写（components.a），本测试必挂。
async (page) => {
  await page.setViewportSize({ width: 900, height: 700 });
  const url = 'http://127.0.0.1:5175/chat-link-harness';
  await page.route(url, route => route.fulfill({ contentType: 'text/html', body: '<div id="root" class="pireplica"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script>' }));
  await page.goto(url);
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    // 记录 window.open 调用（Electron 里它走主进程 setWindowOpenHandler → openExternal）
    window.__opens = [];
    window.open = (u) => { window.__opens.push(String(u)); return null; };
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    await import('/styles.css'); await import('/replica/tokens.css'); await import('/replica/chat/chat.css');
    const { ChatMarkdown } = await import('/replica/chat/ChatView.tsx');
    createRoot(document.getElementById('root')).render(
      React.createElement(ChatMarkdown, {
        text: '看下 https://example.com/docs 页面，也可以点 [显式链接](https://foo.bar/x) 对照。',
        zh: true,
      }),
    );
  });
  await page.waitForSelector('.pi-md a', { timeout: 15000 });

  const probe = await page.evaluate(() => {
    const links = [...document.querySelectorAll('.pi-md a')];
    const first = links[0];
    const style = first ? getComputedStyle(first) : null;
    return {
      linkCount: links.length,
      firstHref: first?.getAttribute('href') ?? null,
      underline: style ? style.textDecorationLine.includes('underline') || style.textDecoration.includes('underline') : false,
      underlineColor: style ? style.textDecorationColor : null,
    };
  });

  let checks = 0;
  const assert = (ok, message) => { if (!ok) throw Error(message); checks++; };
  assert(probe.linkCount === 2, `裸 URL autolink + 显式链接都渲染（实际 ${probe.linkCount} 个 a）`);
  assert(probe.firstHref === 'https://example.com/docs', `autolink href 正确（实际 ${probe.firstHref}）`);
  assert(probe.underline, `链接有下划线（可见可点，text-decoration-color=${probe.underlineColor}）`);

  // 真实点击裸 URL 链接：不允许顶层导航，必须走 window.open
  await page.evaluate(() => document.querySelector('.pi-md a').click());
  await page.waitForTimeout(300);

  const after = await page.evaluate(() => ({
    opens: window.__opens,
    stillRendered: document.querySelectorAll('.pi-md a').length,
    targetBlank: document.querySelector('.pi-md a')?.getAttribute('target') === '_blank',
  }));
  assert(after.opens.length === 1 && after.opens[0] === 'https://example.com/docs',
    `点击走 window.open（实际 ${JSON.stringify(after.opens)}）`);
  assert(after.stillRendered === 2, `点击后消息仍在（无顶层导航/重置，实际 ${after.stillRendered} 个 a）`);
  assert(page.url().includes('chat-link-harness'), `页面 URL 未被导航（实际 ${page.url()}）`);
  assert(after.targetBlank, 'a 带 target=_blank（兜底，即使 onClick 失效也走 setWindowOpenHandler）');

  console.log(`PASS (${checks} checks): 外链点击走系统浏览器通道，无顶层导航，链接有可见样式`);
  return { checks };
}
