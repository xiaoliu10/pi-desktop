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
    const files = [
      { path: '/tmp/diagram.html', excerpt: ['<!doctype html>', '<style>body{background:#eef3f6;color:#26384c}</style>', '<h1 id="mark">渲染OK</h1>', '<script>window.__scriptRan=true; window.__tick=0; setInterval(()=>{window.__tick++},50)</script>'] },
      { path: '/tmp/notes.ts', excerpt: ['export const a = 1;'] },
    ];
    const root = createRoot(document.getElementById('root'));
    // 受控 harness：selectedFile 由外层 state 驱动，才能真实模拟「父层重渲染 / 切换文件」。
    window.__state = { selectedFile: '/tmp/diagram.html' };
    const render = () => root.render(React.createElement(WorkbenchPanel, {
      open: true, tab: 'files', demo: false, cwd: '/tmp',
      diffs: [],
      files,
      selectedFile: window.__state.selectedFile,
      labels,
      onToggle: () => {}, onSelectTab: () => {}, onSelectFile: (path) => { window.__state.selectedFile = path; render(); },
    }));
    window.__renderWorkbench = render;
    window.__selectFile = (path) => { window.__state.selectedFile = path; render(); };
    render();
    // 同文件父层重渲染：用于验证预览文档不会被无关 re-render 重置。
    window.__rerenderSameFile = () => window.__renderWorkbench?.();
    window.__select = (path) => window.__selectFile?.(path);
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

  // 切回渲染视图后再验证高度/隔离
  await page.evaluate(() => [...document.querySelectorAll('.pi-workbench__htmlmode')].find(b => b.textContent === '渲染').click());
  await page.waitForSelector('.pi-workbench__htmlframe', { timeout: 5000 });

  // P0（审查）：iframe 必须撑满 body，而不是退回默认 150px。
  const height = await page.evaluate(() => {
    const f = document.querySelector('.pi-workbench__htmlframe');
    const body = document.querySelector('.pi-workbench__body') ?? document.querySelector('.pi-workbench');
    return { frame: Math.round(f.getBoundingClientRect().height), body: Math.round(body?.getBoundingClientRect().height ?? 0) };
  });
  assert(height.frame >= 200, `iframe 高度撑开而非 150px（实际 ${height.frame}px, body ${height.body}px）`);

  // P1（审查）：脚本在 sandbox 内能跑，但碰不到宿主——断言真实隔离，而不是只读属性。
  await page.evaluate(() => [...document.querySelectorAll('.pi-workbench__htmlmode')].find(b => b.textContent === '渲染').click());
  await page.waitForTimeout(300);
  const isolated = await page.evaluate(() => {
    const f = document.querySelector('.pi-workbench__htmlframe');
    const w = f.contentWindow;
    // 跨源访问宿主文档必须抛 SecurityError；能读到内容就说明隔离失效。
    let host = 'unexpected';
    try { host = String(w.document.title); } catch (e) { host = 'blocked:' + e.name; }
    // 反向探针：从父层拿不到 iframe 的 DOM，也拿不到其内部脚本变量。
    let inner = 'reachable';
    try { inner = String(w.__scriptRan); } catch (e) { inner = 'blocked:' + e.name; }
    return { host, inner, sandboxed: f.getAttribute('sandbox') };
  });
  assert(isolated.sandboxed === 'allow-scripts', 'sandbox 仍为 allow-scripts');
  assert(isolated.host.startsWith('blocked:'), `父层读不到 iframe 文档（实际 ${isolated.host}）`);
  assert(isolated.inner.startsWith('blocked:') || isolated.inner === 'undefined', `父层读不到 iframe 内部脚本状态（实际 ${isolated.inner}）`);

  // P1（审查）：父层无关 re-render 不得重置预览文档。
  // srcDoc 变化会换掉文档（跨源拿不到内部状态），故用 iframe 元素身份 + srcdoc 字符串判断。
  const beforeRender = await page.evaluate(() => {
    const f = document.querySelector('.pi-workbench__htmlframe');
    window.__frameEl = f;
    return f.getAttribute('srcdoc');
  });
  for (let i = 0; i < 3; i++) await page.evaluate(() => window.__rerenderSameFile());
  await page.waitForTimeout(300);
  const afterRender = await page.evaluate(() => {
    const f = document.querySelector('.pi-workbench__htmlframe');
    return { sameEl: f === window.__frameEl, srcdoc: f.getAttribute('srcdoc') };
  });
  assert(afterRender.sameEl, '同文件父层重渲染后 iframe 元素未被替换');
  assert(afterRender.srcdoc === beforeRender, '同文件父层重渲染后 srcdoc 未变（文档不会重置）');

  await page.evaluate(() => document.querySelector('.pi-workbench__htmlopen').click());
  await page.waitForTimeout(150);
  const opened = await page.evaluate(() => ({ frame: !!document.querySelector('.pi-workbench__htmlframe'), files: window.__openedFiles }));
  assert(opened.frame, '切回渲染视图');
  assert(opened.files.length === 1 && opened.files[0] === '/tmp/diagram.html', `系统打开收到文件路径（实际 ${JSON.stringify(opened.files)}）`);

  // 切到非 HTML 文件：iframe 移除；切回 HTML：渲染视图恢复。
  await page.evaluate(() => window.__select('/tmp/notes.ts'));
  await page.waitForTimeout(150);
  assert(!(await page.evaluate(() => !!document.querySelector('.pi-workbench__htmlframe'))), '非 HTML 文件不渲染 iframe');
  await page.evaluate(() => window.__select('/tmp/diagram.html'));
  await page.waitForSelector('.pi-workbench__htmlframe', { timeout: 5000 });
  assert(true, '切回 HTML 恢复渲染视图');

  console.log(`PASS (${checks} checks): HTML 预览默认渲染、可切源码、系统打开可用`);
  return { checks };
}
