// 工作台文件预览：Markdown 交付文件必须默认渲染预览（标题/表格/代码块真实排版），
// 可切换到源码高亮；「系统打开」仍走 openLocalFile IPC。
// 用户 2026-11-04：「md 文档为什么不能在右侧边栏展示了 点击之后使用的系统默认的工具
// 这个不对吧，应该做成右侧边栏支持 md 文档查看并且支持预览模式」。
//
// 跑法：playwright-cli -s=chatlink run-code --filename tests/workbench-markdown-preview.browser.cjs
// 破坏-恢复：WorkbenchPanel 移除 markdown 渲染分支，本测试必挂。
async (page) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  const url = 'http://127.0.0.1:5175/workbench-md-harness';
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
    await import('/replica/chat/chat.css');
    const { WorkbenchPanel } = await import('/replica/workbench/WorkbenchPanel.tsx');
    const labels = {};
    for (const k of ['review','files','browser','auxiliary','homeTitle','homeReview','homeFiles','homeBrowser','homeAuxiliary','close','emptyReview','emptyReviewHint','emptyFiles','emptyFilesHint','emptyBrowser','emptyBrowserHint','created','selectFile']) labels[k] = k;
    const md = [
      '# 交付说明',
      '',
      '这里有 **加粗** 与 `行内代码`。',
      '',
      '| 项目 | 状态 |',
      '| --- | --- |',
      '| 构建 | 通过 |',
      '',
      '```js',
      'const ok = true;',
      '```',
    ];
    const files = [
      { path: '/tmp/DELIVERY.md', excerpt: md },
      { path: '/tmp/plain.mdx', excerpt: ['# mdx 标题', '', '正文'] },
      { path: '/tmp/notes.ts', excerpt: ['export const a = 1;'] },
    ];
    const root = createRoot(document.getElementById('root'));
    window.__state = { selectedFile: '/tmp/DELIVERY.md' };
    const render = () => root.render(React.createElement(WorkbenchPanel, {
      open: true, tab: 'files', demo: false, cwd: '/tmp',
      diffs: [], files, selectedFile: window.__state.selectedFile, labels,
      onToggle: () => {}, onSelectTab: () => {}, onSelectFile: (path) => { window.__state.selectedFile = path; render(); },
    }));
    window.__selectFile = (path) => { window.__state.selectedFile = path; render(); };
    window.__renderWorkbench = render;
    render();
  });

  let checks = 0;
  const assert = (ok, message) => { if (!ok) throw Error(message); checks++; };

  // 1. 默认就是预览：真实渲染出的标题/表格/代码块，而不是纯文本
  await page.waitForSelector('.pi-workbench__mdframe, .pi-workbench__mdpreview', { timeout: 15000 });
  const rendered = await page.evaluate(() => {
    const box = document.querySelector('.pi-workbench__mdframe, .pi-workbench__mdpreview');
    return {
      hasH1: Boolean(box?.querySelector('h1')),
      h1Text: box?.querySelector('h1')?.textContent?.trim() ?? '',
      hasTable: Boolean(box?.querySelector('table')),
      hasStrong: Boolean(box?.querySelector('strong')),
      hasCodeBlock: Boolean(box?.querySelector('pre code')),
      // 纯文本兜底不应出现：源码里的 markdown 记号不该原样显示
      rawHashVisible: (box?.textContent ?? '').includes('# 交付说明'),
    };
  });
  assert(rendered.hasH1 && rendered.h1Text === '交付说明', `标题渲染成 <h1>（实际 h1="${rendered.h1Text}"）`);
  assert(rendered.hasTable, '表格渲染成 <table>');
  assert(rendered.hasStrong, '**加粗** 渲染成 <strong>');
  assert(rendered.hasCodeBlock, '``` 代码块渲染成 <pre><code>');
  assert(!rendered.rawHashVisible, '不再把 markdown 记号原样当纯文本显示');

  // 2. 切到源码：出现行号化的源码视图，h1 消失
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.pi-workbench__htmlmode, .pi-workbench__mdmode')]
      .find(b => (b.textContent || '').includes('源码'));
    btn.click();
  });
  await page.waitForTimeout(250);
  const source = await page.evaluate(() => ({
    codeViewer: Boolean(document.querySelector('.pi-file-code')),
    previewGone: !document.querySelector('.pi-workbench__mdframe, .pi-workbench__mdpreview'),
    rawHashVisible: (document.querySelector('.pi-file-code')?.textContent ?? '').includes('# 交付说明'),
  }));
  assert(source.codeViewer, '切源码后出现源码视图（.pi-file-code）');
  assert(source.previewGone, '切源码后预览容器消失');
  assert(source.rawHashVisible, '源码视图显示原始 markdown 文本');

  // 3. 「系统打开」仍可用（可选入口，不是默认）
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(b => (b.textContent || '').includes('系统打开'));
    btn?.click();
  });
  await page.waitForTimeout(200);
  const opened = await page.evaluate(() => window.__openedFiles);
  assert(opened.length === 1 && opened[0] === '/tmp/DELIVERY.md', `系统打开仍走 openLocalFile（实际 ${JSON.stringify(opened)}）`);

  console.log(`PASS (${checks} checks): Markdown 默认预览 + 可切源码 + 系统打开可选`);
  return { checks };
}
