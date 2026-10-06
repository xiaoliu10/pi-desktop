// 用户消息气泡溢出回归：粘贴 minified 代码（超长无空格 token）时文字不得画出气泡边界。
// 历史 bug：.pi-md 显式 overflow-wrap:break-word 覆盖 bubble 继承的 anywhere，
// break-word 断点不计入 fit-content 测量 → 行尾多排几个字符画出气泡（截图红框）。
// Vite at :5175; playwright-cli run-code --filename tests/user-msg-overflow.browser.cjs
async (page) => {
  const assert = (ok, label) => { if (!ok) throw new Error(label); };
  await page.route('http://127.0.0.1:5175/user-msg-overflow', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script>' }));
  await page.goto('http://127.0.0.1:5175/user-msg-overflow');
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    await import('/replica/tokens.css');
    await import('/pi/replica-app.css');
    await import('/replica/chat/chat.css');
    // 真实消息片段（用户截图中溢出的 minified bundle 代码）
    const longCode = 'th lives in the pi CLI."})]})}function RM(e){const t={};for(const n of e){const i=n.request.method==="input"&&n.request.title==="desktop-ask"&&Gc(n.request.placeholder)!==null,o=t[n.key]??{needsConfirm:"permission",needsConfirmCount:0};o.needsConfirmCount+=1,(i||o.needsConfirm==="userInput")&&(o.needsConfirm="userInput"),t[n.key]=o}return t}function PM(e){return e.request.method==="input"&&e.request.title==="desktop-ask"&&Gc(e.request.placeholder)!==null}function Xf(e){var t;return!!((t=e.request.title)!=null&&t.startsWith("Desktop 审批"))}';
    document.getElementById('root').innerHTML = `
      <main class="pireplica" style="display:flex;height:100vh">
        <div class="pi-msg pi-msg--user" style="width:100%">
          <div class="pi-msg__bubble"><div class="pi-md"><p>${longCode}</p></div></div>
        </div>
      </main>`;
  });
  await page.waitForTimeout(120);
  const m = await page.evaluate(() => {
    const bubble = document.querySelector('.pi-msg__bubble');
    const p = bubble.querySelector('.pi-md p');
    const bR = bubble.getBoundingClientRect();
    const pR = p.getBoundingClientRect();
    // 逐行扫描文字实际绘制右缘（Range 几何，比 client rect 更真）
    const range = document.createRange();
    range.selectNodeContents(p);
    const rects = [...range.getClientRects()].map(r => r.right);
    const textRight = Math.max(...rects);
    return {
      bubbleRight: +bR.right.toFixed(1),
      bubbleWidth: Math.round(bR.width),
      textRight: +textRight.toFixed(1),
      overflowPx: +(textRight - bR.right).toFixed(1),
      clip: getComputedStyle(bubble).overflow,
    };
  });
  console.log('MEASURE', JSON.stringify(m));
  // 可视化留证：把测量值标到页面（截图可读）
  await page.evaluate((d) => { document.title = JSON.stringify(d); const bar = document.createElement('div'); bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#111;color:#0f0;font:12px monospace;padding:6px'; bar.textContent = `overflow=${d.overflowPx}px bubbleW=${d.bubbleWidth} clip=${d.clip}`; document.body.appendChild(bar); }, m);
  await page.screenshot({ path: 'output/playwright/user-msg-overflow.png' });
  assert(m.overflowPx <= 1, `文字右缘超出气泡 ${m.overflowPx}px`);
  assert(m.clip === 'hidden', 'bubble 缺少 overflow:hidden 兜底裁剪');
  console.log('USER MSG OVERFLOW OK');
}
