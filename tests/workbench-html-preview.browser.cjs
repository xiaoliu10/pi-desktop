// 工作台文件预览：HTML 交付文件必须可切换「渲染 / 源码」（默认渲染），
// 渲染走 sandbox iframe（无同源、脚本隔离）；「系统打开」按钮走 openLocalFile IPC。
// 跑法：playwright-cli -s=chatlink run-code --filename tests/workbench-html-preview.browser.cjs
// 破坏-恢复：WorkbenchPanel 移除 html 渲染分支，本测试必挂。
async (page) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  const url = 'http://127.0.0.1:5175/workbench-html-harness';
  await page.route(url, route => route.fulfill({ contentType: 'text/html', body: '<div id="root" class="pireplica"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script>' }));
  await page.goto(url);
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    window.__openedFiles = [];
    window.localPi = { openLocalFile: (p) => { window.__openedFiles.push(p); return Promise.resolve({ action: 'opened' }); } };
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    await import('/styles.css'); await import('/replica/tokens.css'); await import('/replica/workbench/workbench.css');
    const { WorkbenchPanel } = await import('/replica/workbench/WorkbenchPanel.tsx');
    const labels = {};
    for (const k of ['review','files','browser','auxiliary','homeTitle','homeReview','homeFiles','homeBrowser','homeAuxiliary','close','emptyReview','emptyReviewHint','emptyFiles','emptyFilesHint','emptyBrowser','emptyBrowserHint','created','selectFile']) labels[k] = k;
    createRoot(document.getElementById('root')).render(
      React.createElement(WorkbenchPanel, {
        open: true, tab: 'files', demo: false, cwd: '/tmp',
        diffs: [],
        files: [{ path: '/tmp/diagram.html', excerpt: ['<!doctype html>', '<style>body{background:#eef3f6;color:#26384c}</style>', '<h1 id="mark">渲染OK</h1>', '<script>window.__scriptRan=true</script>'] }],
        selectedFile: '/tmp/diagram.html',
        labels,
        onToggle: () => {}, onSelectTab: () => {}, onSelectFile: () => {},
      }),
    );
  });
  await page.waitForSelector('.pi-workbench__htmlframe', { timeout: 15000 });

  let checks = 0;
  const assert = (ok, message) => { if (!ok) throw Error(message); checks++; };

  const frame = await page.evaluate(() => {
    const f = document.querySelector('.pi-workbench__htmlframe');
    return { sandbox: f?.getAttribute('sandbox'), srcdoc: f?.getAttribute('srcdoc') ?? '', modes: [...document.querySelectorAll('.pi-workbench__htmlmode')].map(b => b.textContent) };
  });
  assert(frame.sandbox === 'allow-scripts', `iframe sandbox=allow-scripts（实际 ${frame.sandbox}）`);
  assert(frame.srcdoc.includes('渲染OK') && frame.srcdoc.includes('<style>'), `srcdoc 为完整 HTML（实际 ${frame.srcdoc.slice(0, 80)}）`);
  assert(frame.modes.join('/') === '渲染/源码', `渲染/源码切换存在（实际 ${frame.modes.join('/')}）`);

  await page.evaluate(() => [...document.querySelectorAll('.pi-workbench__htmlmode')].find(b => b.textContent === '源码').click());
  await page.waitForTimeout(120);
  const source = await page.evaluate(() => ({ frame: !!document.querySelector('.pi-workbench__htmlframe'), code: document.querySelector('.pi-file-code')?.textContent ?? '' }));
  assert(!source.frame, '源码视图下 iframe 消失');
  assert(source.code.includes('<h1 id="mark">'), '源码视图展示完整 HTML 源码');

  await page.evaluate(() => [...document.querySelectorAll('.pi-workbench__htmlmode')].find(b => b.textContent === '渲染').click());
  await page.evaluate(() => document.querySelector('.pi-workbench__htmlopen').click());
  await page.waitForTimeout(150);
  const opened = await page.evaluate(() => ({ frame: !!document.querySelector('.pi-workbench__htmlframe'), files: window.__openedFiles }));
  assert(opened.frame, '切回渲染视图');
  assert(opened.files.length === 1 && opened.files[0] === '/tmp/diagram.html', `系统打开收到文件路径（实际 ${JSON.stringify(opened.files)}）`);

  console.log(`PASS (${checks} checks): HTML 预览默认渲染、可切源码、系统打开可用`);
  return { checks };
}
