// 聊天消息 file:// 交付文件链接：点击必须走 localPi.openLocalFile（系统默认应用/Finder），
// 不得像旧版一样「有下划线但点了没反应」（非 http(s) 提前 return + target=_blank 被主进程 deny）。
// 跑法：playwright-cli -s=chatlink run-code --filename tests/chat-file-link-click.browser.cjs
// 破坏-恢复：ChatMarkdown 的 a onClick 若恢复为非 http(s) 不处理，本测试必挂。
async (page) => {
  await page.setViewportSize({ width: 900, height: 700 });
  const url = 'http://127.0.0.1:5175/chat-file-link-harness';
  await page.route(url, route => route.fulfill({ contentType: 'text/html', body: '<div id="root" class="pireplica"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script>' }));
  await page.goto(url);
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    window.__opens = [];
    window.__openedFiles = [];
    window.open = (u) => { window.__opens.push(String(u)); return null; };
    window.localPi = { openLocalFile: (p) => { window.__openedFiles.push(p); return Promise.resolve({ action: 'opened' }); } };
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    await import('/styles.css'); await import('/replica/tokens.css'); await import('/replica/chat/chat.css');
    const { ChatMarkdown } = await import('/replica/chat/ChatView.tsx');
    createRoot(document.getElementById('root')).render(
      React.createElement(ChatMarkdown, {
        text: '- [高清 PNG](file:///Users/jason/ai-workspace/design/浙江省财政厅生产环境部署架构图/浙江省财政厅生产环境部署架构图-简化版.png)\n- [PDF](file:///Users/a%20b/report.pdf)\n- [文档](https://example.com/docs)',
        zh: true,
      }),
    );
  });
  await page.waitForSelector('.pi-md a', { timeout: 15000 });

  let checks = 0;
  const assert = (ok, message) => { if (!ok) throw Error(message); checks++; };
  const links = await page.evaluate(() => [...document.querySelectorAll('.pi-md a')].map(a => a.getAttribute('href')));
  assert(links.length === 3, `三条链接都渲染（实际 ${links.length}）`);
  assert(links[0]?.startsWith('file:///Users/jason/ai-workspace/'), `file:// href 不被 react-markdown 剥掉（实际 ${links[0]}）`);
  assert(links[1] === 'file:///Users/a%20b/report.pdf', `第二条 file:// href 保留（实际 ${links[1]}）`);

  await page.evaluate(() => document.querySelectorAll('.pi-md a')[0].click());
  await page.evaluate(() => document.querySelectorAll('.pi-md a')[1].click());
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => ({ opened: window.__openedFiles, opens: window.__opens, url: location.href }));
  assert(after.opened.length === 2, `两次 file:// 点击都触发 openLocalFile（实际 ${JSON.stringify(after.opened)}）`);
  assert(after.opened[0] === '/Users/jason/ai-workspace/design/浙江省财政厅生产环境部署架构图/浙江省财政厅生产环境部署架构图-简化版.png',
    `中文路径原样解码（实际 ${after.opened[0]}）`);
  assert(after.opened[1] === '/Users/a b/report.pdf', `%20 解码为空格（实际 ${after.opened[1]}）`);
  assert(after.opens.length === 0, `file:// 不走 window.open（实际 ${JSON.stringify(after.opens)}）`);
  assert(after.url.includes('chat-file-link-harness'), `无顶层导航（实际 ${after.url}）`);

  await page.evaluate(() => document.querySelectorAll('.pi-md a')[2].click());
  await page.waitForTimeout(200);
  const web = await page.evaluate(() => window.__opens);
  assert(web.length === 1 && web[0] === 'https://example.com/docs', `https 仍走 window.open（实际 ${JSON.stringify(web)}）`);

  // 文件不存在（IPC reject）时链接旁必须出现可见提示，不再是死链
  await page.evaluate(() => {
    window.localPi.openLocalFile = () => Promise.reject(new Error('文件不存在或不可访问'));
    document.querySelector('.pi-md a').click();
  });
  await page.waitForTimeout(200);
  const failedNote = await page.evaluate(() => document.querySelector('.pi-md__open-failed')?.textContent ?? null);
  assert(failedNote && failedNote.includes('不可访问'), `打开失败有可见提示（实际 ${failedNote}）`);

  console.log(`PASS (${checks} checks): file:// 链接点击可打开本地文件，http 行为不变，无死链/无导航`);
  return { checks };
}
