// 工作面板宽度上限随窗口走（真实浏览器验证）：1920 宽视口下拖拽能超过旧 700 上限
// 到 60% 窗口宽；视口缩小时宽度自动回钳，不把对话区挤没。
//
// 跑法：npx vite --host 127.0.0.1 --port 5175 --strictPort（后台）
//       playwright-cli -s=wbwidth run-code --filename tests/workbench-width.browser.cjs
async (page) => {
  await page.setViewportSize({ width: 1920, height: 989 });
  const url = 'http://127.0.0.1:5175/workbench-width-harness';
  await page.route(url, route => route.fulfill({ contentType: 'text/html', body: '<div id="root" class="pireplica"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script>' }));
  await page.goto(url);
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);

  await page.evaluate(async () => {
    // 镜像 PiReplicaApp 的真实接线：同一 usePanelWidth + ResizeHandle + panelMaxForWindow
    // 组合、同一 clamp-on-shrink effect。fixture 只换掉外层布局。
    localStorage.removeItem('pi.workbenchWidth');
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    await import('/styles.css'); await import('/pi/replica-app.css');
    const { ResizeHandle, usePanelWidth, panelMaxForWindow } = await import('/replica/shell/ResizeHandle.tsx');

    window.__widths = [];
    function Harness() {
      const [windowWidth, setWindowWidth] = React.useState(() => window.innerWidth);
      React.useEffect(() => {
        const onResize = () => setWindowWidth(window.innerWidth);
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
      }, []);
      const max = panelMaxForWindow(windowWidth);
      const [width, setWidth] = usePanelWidth('pi.workbenchWidth', 415, 300, max);
      React.useEffect(() => { if (width > max) setWidth(max); }, [max, width, setWidth]);
      window.__widths.push(width);
      window.__max = max;
      window.__setWidth = setWidth;
      return React.createElement('div', { style: { display: 'flex', width: '100%', height: 400 } },
        React.createElement('div', { id: 'chat', style: { flex: 1 } }, 'chat'),
        React.createElement(ResizeHandle, {
          side: 'right', width, min: 300, max, onChange: setWidth,
          onReset: () => setWidth(415), label: '工作面板宽度',
        }),
        React.createElement('div', { id: 'panel', style: { width, flexShrink: 0 } }, 'workbench'),
      );
    }
    createRoot(document.getElementById('root')).render(React.createElement(Harness));
  });
  await page.waitForSelector('.pi-resizehandle', { timeout: 15000 });
  await page.waitForFunction(() => Number.isFinite(window.__max));

  let checks = 0;
  const assert = (ok, message) => { if (!ok) throw Error(message); checks++; };

  // 1) 1920 视口：动态上限 = 1152（60%），不再是旧固定 700
  const maxWide = await page.evaluate(() => window.__max);
  assert(maxWide === 1152, `1920 视口上限应为 1152（实际 ${maxWide}）`);

  // 2) 拖拽把手向左加宽面板，越过旧 700 上限直达动态上限
  const handle = await page.locator('.pi-resizehandle').boundingBox();
  const hx = handle.x + handle.width / 2, hy = handle.y + handle.height / 2;
  await page.mouse.move(hx, hy);
  await page.mouse.down();
  await page.mouse.move(hx - 900, hy, { steps: 8 }); // side=right：向左拖 = 加宽
  await page.mouse.up();
  await page.waitForTimeout(100);
  const afterDrag = await page.evaluate(() => ({ width: window.__widths.at(-1), panel: document.getElementById('panel').offsetWidth }));
  assert(afterDrag.width === 1152, `拖拽应加宽到动态上限 1152（实际 state=${afterDrag.width}，修复前会被钳在 700）`);
  assert(afterDrag.panel === 1152, `面板实际宽度应同步 1152（实际 DOM=${afterDrag.panel}）`);

  // 3) 视口缩到 1000：上限回钳到保底 700，面板宽度跟收回钳
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.waitForTimeout(200);
  const afterShrink = await page.evaluate(() => ({ max: window.__max, width: window.__widths.at(-1), panel: document.getElementById('panel').offsetWidth }));
  assert(afterShrink.max === 700, `1000 视口上限应回钳 700（实际 ${afterShrink.max}）`);
  assert(afterShrink.width === 700, `面板宽度应自动回钳 700（实际 state=${afterShrink.width}）`);
  assert(afterShrink.panel === 700, `面板 DOM 宽度应回钳 700（实际 ${afterShrink.panel}）`);

  // 4) 持久化值同步回钳后的宽度
  const stored = await page.evaluate(() => Number(localStorage.getItem('pi.workbenchWidth')));
  assert(stored === 700, `localStorage 应记录回钳后的 700（实际 ${stored}）`);

  return `PASS workbench-width: ${checks} checks（1920 拖到 1152 / 缩窗回钳 700）`;
}
